// nano-workforce — single-issue feature run (issue #172).
//
// The "missing middle" dispatch surface, between Epics (plan-fanout: one issue →
// many PRs) and PR convergence (an already-open PR → review → merge): hand ONE
// issue to a single implementation agent (`senior:feature`), which raises exactly
// ONE PR, then OPTIONALLY hand that PR to the convergence loop (and, with
// auto-merge, the merge-loop).
//
// This module is the seam the `startFeature` action and the `feature.bpmn` record
// workers call: it owns the `feature_runs` row shape, the per-run task derivation,
// and starting the process. It deliberately REUSES the epic primitives rather than
// forking them — `parseIssue`/`renderBaseBranchBrief`/`normalizeBaseBranch` and the
// `ESCALATION_SLA_TIMEOUT` come from app/plan.ts, and the downstream PR lifecycle is
// the existing convergence loop (`submitPr`), keyed on `pr_key` → `pull_requests`.
// Data access goes through the record gateway (`data.table`), never hand-written
// SQL — matching app/plan.ts and app/service.ts.
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import { coalesceTitle, fetchIssueTitle } from "./github.ts";
import { ESCALATION_SLA_TIMEOUT, normalizeBaseBranch, type ParsedIssue, renderBaseBranchBrief } from "./plan.ts";
import { deriveEscalationOpen, deriveListBucket, deriveStage } from "./stage.ts";

/** The BPMN process this module drives (resources/processes/feature.bpmn). */
export const FEATURE_PROCESS_ID = "feature";

const now = () => new Date().toISOString();

/** One row per issue handed to a single implementation agent. Keyed on `feature_key`
 * (`<owner>/<repo>#<issue-number>`, the same string `parseIssue` returns as `planKey`).
 * The downstream PR lifecycle (review/merge) is NOT duplicated here — once `converge`
 * hands the opened PR to `submitPr`, its live state lives on the `pull_requests` row
 * keyed by `pr_key`. */
export interface FeatureRun {
  feature_key: string;
  repo: string;
  issue_number: number;
  issue_url: string;
  /** Human-readable identity (the GitHub issue title) for the feature grids (issue #248). Fetched
   * best-effort at `startFeature` and coalesced to the `owner/repo#N` key at write time, so it is
   * ALWAYS non-blank — the grid's `{{title}}` template needs no fallback and a failed/absent title
   * fetch still shows a usable identity (the key) rather than an empty cell. */
  title: string | null;
  base_branch: string;
  status: FeatureRunStatus;
  process_key: string | null;
  pr_key: string | null;
  converge: number;
  auto_merge: number;
  outcome: string | null;
  /** Human rollup detail. Projected by `pollFeatureDelivery` (fix: Feature history stuck at
   * `converging`) and also written by `pr.record-blocked-ack` with the operator's disposition
   * note when a blocked run is acknowledged. NULL until there is a signal. The reconciled TERMINAL
   * outcome is written to `status` itself; this carries the sub-state / note (e.g. "merged",
   * "waiting_review", or "operator: <note>"). */
  delivery_label: string | null;
  /** The parked `feature-escalation` user task's `question`, persisted at escalation entry by the
   * `record-feature-escalation` worker (NOT by `pollFeatureEscalations` while parked, which
   * deliberately never writes it) so the pages can show what the agent asked. NULL whenever the run
   * is not parked at an escalation — cleared on the exit paths (`record-feature` / the answer
   * operation), and, as a self-heal, by `pollFeatureEscalations` when a previously-observed task is
   * completed out-of-band (see `deriveFeatureEscalationPatch`). */
  escalation_question: string | null;
  /** The completable native `feature-escalation` user-task key the answer affordance posts to
   * (`completeUserTaskAttributed`) and the pages gate the answer controls on (`showWhenField`). Set by
   * `pollFeatureEscalations` while parked; NULL otherwise. */
  escalation_user_task_key: string | null;
  /** Gateway projection (issue #272): the single fail-closed "open escalation" display signal, `1` iff
   * ALL THREE escalation columns agree the run is parked at an answerable escalation
   * (`status='escalated'` AND `escalation_user_task_key` non-NULL AND `escalation_question` non-NULL),
   * else `0`. Derived by `deriveEscalationOpen` at write time. The escalation tuple is spread across
   * three independently-written columns, so an interim read can see a TORN state (a live pointer with a
   * blank question, or a status lagging behind a cleared question); the pages gate the Abandon action
   * and the answer form on THIS conjunction instead of on `escalation_user_task_key` alone, so a torn
   * tuple renders as not-escalated rather than escalated-but-blank. NULL only on legacy rows before the
   * projection reached them (backfilled once at boot). */
  escalation_open: number | null;
  /** The completable native `feature-blocked` user-task key the "Acknowledge blocked" affordance posts
   * to (`completeUserTaskAttributed`) and the pages gate the acknowledge control on (`showWhenField`).
   * Kept DISTINCT from `escalation_user_task_key` so the two human tasks (an escalation answer vs a
   * blocked-run acknowledgement) are never conflated. Set by `pollFeatureBlocked` while a run is parked
   * at `feature-blocked` (status `awaiting_operator`); NULL otherwise — cleared on the exit paths
   * (`record-blocked-ack` / the acknowledge operation) and, as a self-heal, by `pollFeatureBlocked`
   * when a previously-observed task is completed out-of-band (see `deriveFeatureBlockedPatch`). */
  blocked_user_task_key: string | null;
  /** Timestamp an operator dismissed a TERMINAL run (§5, `acknowledge-done`); NULL until then. When
   * set on a terminal row, `list_bucket` flips from 'active' to 'history'. Projection surface. */
  acknowledged_at: string | null;
  /** Projection maintained by the feature_runs gateway (like `delivery_label`): the canonical pipeline
   * stage key from `deriveStage` (Requested|Implementing|PR open|Converging|Merging|Done). The page's
   * pipeline column binds `activeField` to it. NULL only on legacy rows before `backfillFeatureStages`. */
  stage: string | null;
  /** Gateway projection: the active stage's render state from `deriveStage` (`ok`|`failed`|`blocked`|
   * NULL). The page binds `stateField` to it; NULL means in-progress (renderer shows `active`). */
  stage_state: string | null;
  /** Gateway projection: space-separated set of stage keys NOT in this row's path from `deriveStage`
   * (derived from `converge`/`auto_merge`). The page binds `notInPathField` to it. */
  stage_skipped: string | null;
  /** Gateway projection: a short attention badge (`blocked` / `⚠`) for the active stage, or NULL, from
   * `deriveStage`. The page binds `badgeField` to it. */
  attention: string | null;
  /** Gateway projection: the Active/History partition label ('active'|'history'), 'history' iff a
   * terminal row has been acknowledged. The page's tabs filter on it with flat `in` clauses (§5). */
  list_bucket: string | null;
  created_at: string;
  updated_at: string;
}

export const FEATURE_RUN_STATUSES = [
  "running", // the agent is implementing
  "escalated", // NON-terminal: the run is parked at the `feature-escalation` operator user task,
  // waiting on a human answer (denormalised from the parked user task by pollFeatureEscalations)
  "opened", // a PR was raised and the run ends here (converge was not requested)
  "converging", // the opened PR was handed to the convergence loop (live state via pr_key → pull_requests)
  "awaiting_operator", // NON-terminal: the run is blocked and parked at the feature-blocked operator user task
  "merged", // reconciled: the handed-off PR MERGED (pollFeatureDelivery, from pull_requests.status)
  "converged", // reconciled: the handed-off PR converged but did not merge (auto-merge off)
  "blocked", // the agent could not open a PR (gave up / escalation abandoned)
  "skipped", // nothing to do
  "failed", // an unexpected failure
  "abandoned", // reconciled: the handed-off PR was abandoned (pollFeatureDelivery), or the process
  // instance itself was cancelled (set by instanceTracking.onTerminated)
] as const;
export type FeatureRunStatus = typeof FEATURE_RUN_STATUSES[number];

/** A feature run is finished once it leaves `running`. Mirrors PLAN_TERMINAL_STATUSES: a
 * re-dispatch of the same issue restarts only when the prior run has settled. `converging` stays
 * terminal-for-redispatch even though `pollFeatureDelivery` may later advance it to
 * `merged`/`converged`/`abandoned` — those are equally terminal, so redispatch gating is unaffected.
 * `awaiting_operator` is deliberately EXCLUDED (non-terminal): while a blocked run is parked at the
 * feature-blocked operator user task its instance is still alive, so a re-dispatch of the same issue
 * must short-circuit (no orphaned parallel instance) until the operator acknowledges it. `escalated`
 * is EXCLUDED for the same reason: a run parked at the `feature-escalation` user task is still alive,
 * so a re-dispatch must short-circuit until the human answers (or the SLA fires). */
export const FEATURE_TERMINAL_STATUSES: readonly FeatureRunStatus[] = [
  "opened",
  "converging",
  "merged",
  "converged",
  "blocked",
  "skipped",
  "failed",
  "abandoned",
];

/** Reconciled delivery outcome for a single feature run, derived from its handed-off PR's
 * `pull_requests.status`. Pure and read-only — the source of truth for the denormalised
 * `feature_runs.status` transition + `feature_runs.delivery_label` that `pollFeatureDelivery`
 * projects. Only meaningful for a run currently `converging` with a `pr_key`. */
export interface FeatureDeliveryRollup {
  /** The reconciled `feature_runs.status`. Stays `converging` while the PR is still in flight
   * (or its row is missing); advances to the matching terminal outcome once the PR settles. */
  status: FeatureRunStatus;
  /** Human rollup detail for the row (`delivery_label`). */
  label: string;
}

/** Map a handed-off PR's `pull_requests.status` to the feature run's reconciled outcome.
 *
 * - `merged` → `merged` (the win). `converged` → `converged` (review done, not merged — auto-merge
 *   was off). `abandoned` → `abandoned`.
 * - in-flight PR statuses (`converging`/`waiting_review`/`escalated`) keep the run `converging`,
 *   surfacing the live sub-state as the label so the grid stops looking frozen.
 * - `null` (the `pull_requests` row is missing — DB desync) keeps the run `converging` and labels
 *   it so the desync is visible, never a false-positive terminal. */
export function deriveFeatureDelivery(prStatus: string | null): FeatureDeliveryRollup {
  switch (prStatus) {
    case "merged":
      return { status: "merged", label: "merged" };
    case "converged":
      return { status: "converged", label: "converged (not merged)" };
    case "abandoned":
      return { status: "abandoned", label: "PR abandoned" };
    case null:
      return { status: "converging", label: "PR record missing" };
    default:
      return { status: "converging", label: prStatus };
  }
}

/** The `feature-escalation` user-task element id (feature.bpmn) — the native operator wait a run
 * parks on when the agent escalates. `pollFeatureEscalations` reconciles it onto the read model. */
export const FEATURE_ESCALATION_ELEMENT = "feature-escalation";

/** One append-only audit row per `feature-escalation` ENTRY (issue #305). Mirrors the surviving
 *  `plan_reviews` / `escalations` / `plan_trial_merges` audit logs: it is the canonical, poller-readable
 *  source for a parked run's escalation `question`, so the denormalised `feature_runs.escalation_question`
 *  column can be dropped in the later contract phase. `id` is an AUTOINCREMENT PK, so the newest row per
 *  `feature_key` is the live question (`latestFeatureEscalationQuestion`). Never updated or deleted. */
export interface FeatureEscalationRow {
  id: number;
  feature_key: string;
  question: string | null;
  created_at: string;
}

/** Accessor for the append-only `feature_escalations` audit log (migration 048). Written by
 *  `record-feature-escalation` (one row per escalation entry), read by `pollUserTasks` to enrich the
 *  open `feature-escalation` task's question — the feature analogue of `plan_reviews` / `escalations`. */
export const featureEscalations = (data: DataLayer) =>
  data.table<FeatureEscalationRow>("feature_escalations", "id");

/** Append one `feature_escalations` audit row capturing the agent's escalation `question` while it is
 *  still in scope on the `record-feature-escalation` job. Append-only, so this is the canonical record
 *  of what was asked — `pollUserTasks` reads the newest row per feature as the live question. */
export async function recordFeatureEscalation(
  data: DataLayer,
  entry: { featureKey: string; question: string | null },
): Promise<void> {
  await featureEscalations(data).insert({
    feature_key: entry.featureKey,
    question: entry.question,
    created_at: new Date().toISOString(),
  });
}

/** The parked `feature-escalation` user task, as `pollFeatureEscalations` observes it via
 *  `openUserTasks` (the open-task-scoped query — issue #294): the completable user-task key the pages
 *  drive an attributed answer against. Scoping to `state:"CREATED"` is what keeps a looping run — which
 *  holds COMPLETED prior-round tasks for the same element — from latching the pointer onto a dead task.
 *
 * The agent's `question` is NOT read from here — the WASM testkit engine does not surface a user
 * task's `zeebe:ioMapping`-mapped local variables through the user-task query, so relying on it would
 * make the question untestable. Instead the `record-feature-escalation` service task (feature.bpmn)
 * persists `question` onto the row at escalation entry — see `workers/record-feature-escalation`. */
export interface FeatureEscalationParked {
  userTaskKey: string;
}

/** Pure source of truth for the escalation read-model reconcile (`pollFeatureEscalations`): given a
 * run and whether it is currently parked at `feature-escalation`, return the minimal `feature_runs`
 * patch reconciling the run's LIVENESS (status + completable-task pointer) with the observed park
 * state (or null when nothing changed, so the poller skips the write). Idempotent, and — crucially —
 * self-healing across the brief window between the `record-feature-escalation` service task and the
 * user task actually appearing: a premature "not parked" reset to `running` is re-flipped to
 * `escalated` on the next pass once the task is observed.
 *
 * - parked → flip `status` to `escalated` and denormalise the completable `userTaskKey` so the pages
 *   can drive an attributed answer. It never writes `escalation_question` while parked — that is the
 *   service task's to own (set) and the exit paths' to clear (record-feature / the answer operation),
 *   so the poller can never clobber the persisted question during that self-healing window.
 * - un-parked → clear the completable-task pointer; a run still marked `escalated` has resumed
 *   (answered / looped back to implement-task), so it returns to `running`. A run already advanced
 *   past `escalated` by a downstream worker keeps that status — only the pointer is cleared. Once the
 *   pointer was actually OBSERVED (non-NULL) and the task is now gone, `escalation_question` is also
 *   cleared here, self-healing a question left populated when the task was completed out-of-band
 *   (bypassing the answer operation). This is gated on the observed pointer precisely so it cannot
 *   fire in the pre-observation self-healing window, where the pointer is still NULL. */
export function deriveFeatureEscalationPatch(
  run: Pick<FeatureRun, "status" | "escalation_user_task_key">,
  parked: FeatureEscalationParked | null,
): Partial<FeatureRun> | null {
  const patch: Partial<FeatureRun> = {};
  if (parked) {
    if (run.status !== "escalated") patch.status = "escalated";
    if (run.escalation_user_task_key !== parked.userTaskKey) patch.escalation_user_task_key = parked.userTaskKey;
  } else {
    if (run.status === "escalated") patch.status = "running";
    // Un-park cleanup — fires ONLY once the poller has actually OBSERVED the task (pointer non-NULL)
    // and it is now gone. This self-heals a `question` left populated when the task was completed
    // out-of-band (e.g. an external task UI, bypassing the answer operation that normally clears it),
    // which would otherwise keep the UI showing an Escalation on a run that has resumed. Gating on
    // the pointer being non-NULL is what makes it safe: during the brief self-healing window between
    // `record-feature-escalation` (which persists the question but leaves the pointer NULL) and the
    // task appearing, the pointer is NULL, so this never clobbers the freshly-persisted question.
    if (run.escalation_user_task_key !== null) {
      patch.escalation_user_task_key = null;
      patch.escalation_question = null;
    }
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** The `feature-blocked` user-task element id (feature.bpmn) — the native operator wait a run parks on
 * when the agent reports a `blocked` outcome (it gave up / the escalation was abandoned or timed out).
 * `pollFeatureBlocked` reconciles it onto the read model. */
export const FEATURE_BLOCKED_ELEMENT = "feature-blocked";

/** The parked `feature-blocked` user task, as `pollFeatureBlocked` observes it via `openUserTasks`
 *  (the open-task-scoped query — issue #294): the completable user-task key the pages drive an
 *  attributed acknowledgement against. Scoping to `state:"CREATED"` keeps a re-blocked run — which
 *  holds COMPLETED prior-round tasks for the same element — from latching the pointer onto a dead task. */
export interface FeatureBlockedParked {
  userTaskKey: string;
}

/** Pure source of truth for the blocked read-model reconcile (`pollFeatureBlocked`), the blocked twin
 * of `deriveFeatureEscalationPatch`: given a run and whether it is currently parked at `feature-blocked`,
 * return the minimal `feature_runs` patch reconciling the completable-task pointer with the observed park
 * state (or null when nothing changed, so the poller skips the write). Idempotent and self-healing.
 *
 * Unlike the escalation reconcile, the STATUS flip is NOT owned here: `record-feature` already persists
 * the row as `awaiting_operator` in the same token path before the `feature-blocked` user task is
 * created, and `record-blocked-ack` settles it to the terminal `blocked` on completion. So this only
 * reconciles the completable-task POINTER — never the status — so it can never overwrite the terminal
 * `blocked` the acknowledgement worker has already written.
 *
 * - parked → denormalise the completable `userTaskKey` so the pages can drive an attributed acknowledge.
 * - un-parked → clear the pointer ONLY once it was actually OBSERVED (non-NULL) and the task is now gone.
 *   Gating on the observed pointer is what makes it safe across the brief self-healing window between
 *   `record-feature` (which persists `awaiting_operator` but leaves the pointer NULL) and the user task
 *   appearing: in that window the pointer is NULL, so this never fires, and the next pass fills it in once
 *   the task is observable. Once observed and then gone (e.g. an out-of-band completion), the stale
 *   pointer is cleared so the pages stop offering an acknowledge control for a task that no longer exists. */
export function deriveFeatureBlockedPatch(
  run: Pick<FeatureRun, "blocked_user_task_key">,
  parked: FeatureBlockedParked | null,
): Partial<FeatureRun> | null {
  const patch: Partial<FeatureRun> = {};
  if (parked) {
    if (run.blocked_user_task_key !== parked.userTaskKey) patch.blocked_user_task_key = parked.userTaskKey;
  } else {
    // Un-park cleanup — fires ONLY once the poller has actually OBSERVED the task (pointer non-NULL) and
    // it is now gone. Gating on the pointer being non-NULL is what makes it safe: during the brief
    // self-healing window between `record-feature` (which persists `awaiting_operator` but leaves the
    // pointer NULL) and the task appearing, the pointer is NULL, so this never clears prematurely.
    if (run.blocked_user_task_key !== null) patch.blocked_user_task_key = null;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** The feature_runs fields the projection reads. A patch touching none of these cannot change the
 * derived `stage`/`stage_state`/`stage_skipped`/`attention`/`list_bucket`, so the gateway can skip the
 * read-back+reproject for it (see the `update` proxy). Kept adjacent to `projectFeatureRun` so the two
 * stay in lockstep — every field `projectFeatureRun` reads MUST appear here. */
const PROJECTION_INPUT_KEYS: readonly (keyof FeatureRun)[] = [
  "status",
  "pr_key",
  "converge",
  "auto_merge",
  "escalation_question",
  "escalation_user_task_key",
  "blocked_user_task_key",
  "acknowledged_at",
];

/** The feature_runs fields the projection WRITES. Included in the reproject trigger so a caller who
 * writes a derived column directly (e.g. `stage`/`list_bucket`) can never bypass derivation: the
 * gateway re-reads, recomputes, and OVERRIDES the raw value with the canonical derived one, keeping
 * "the gateway is the one projection source" a true invariant. Must mirror `projectFeatureRun`'s keys. */
const PROJECTION_OUTPUT_KEYS: readonly (keyof FeatureRun)[] = [
  "stage",
  "stage_state",
  "stage_skipped",
  "attention",
  "list_bucket",
  "escalation_open",
];

/** True when a patch changes at least one field the projection derives from OR one it writes — i.e. the
 * projection must be recomputed. A patch touching only projection-irrelevant fields (e.g. `updated_at`)
 * leaves the stored projection correct, since the gateway is the sole write path (see `featureRuns`); a
 * patch that writes a derived column directly still forces a reproject so derivation can't be bypassed. */
function patchAffectsProjection(patch: Partial<FeatureRun>): boolean {
  return PROJECTION_INPUT_KEYS.some((k) => k in patch) || PROJECTION_OUTPUT_KEYS.some((k) => k in patch);
}

/** Compute the write-time projection columns for a fully-merged feature_runs row. Centralised so the
 * gateway is the ONE place `deriveStage` / `deriveListBucket` are applied — the page, SQL, pollers and
 * workers never re-derive the mapping (AGENTS.md "derivation over duplication"). */
function projectFeatureRun(row: Partial<FeatureRun>): Partial<FeatureRun> {
  if (!row.status) return {};
  const { stage, state, skipped, attention } = deriveStage({
    status: row.status,
    pr_key: row.pr_key ?? null,
    converge: row.converge ?? null,
    auto_merge: row.auto_merge ?? null,
    escalation_question: row.escalation_question ?? null,
    escalation_user_task_key: row.escalation_user_task_key ?? null,
    blocked_user_task_key: row.blocked_user_task_key ?? null,
  });
  return {
    stage,
    stage_state: state,
    stage_skipped: skipped,
    attention,
    list_bucket: deriveListBucket(row.status, row.acknowledged_at ?? null),
    escalation_open: deriveEscalationOpen({
      status: row.status,
      escalation_question: row.escalation_question ?? null,
      escalation_user_task_key: row.escalation_user_task_key ?? null,
    })
      ? 1
      : 0,
  };
}

/** The feature_runs record gateway (keyed on `feature_key`). Wrapped in a thin projecting proxy so the
 * derived pipeline columns (`stage`/`stage_state`/`stage_skipped`/`attention`/`list_bucket`) CANNOT be
 * missed by any writer: `insert` and `update` merge the incoming values over the current stored row,
 * then recompute the projection from that post-write field set and write it alongside — exactly the
 * `delivery_label`-style write-time projection, but hoisted to the single gateway so the many scattered
 * status writers (startFeature, the service pollers/reconcilers, the acknowledge operations, and the
 * feature workers) all stay UNCHANGED and automatically get a correct, fresh projection. `update`
 * skips the read-back+reproject for a patch that touches no projection input (e.g. an `updated_at`-only
 * poller write), avoiding a needless `get` roundtrip — the stored projection is already correct since
 * this gateway is the sole write path. Every other method delegates straight through. This is the sole
 * runtime/app-layer WRITE path to feature_runs (no app-code raw SQL, no other `data.table("feature_runs")`
 * mutation — read-only direct reads in e2e tests, and forward-only data migrations such as
 * `db/migrations/036_backfill_titles.sql`, notwithstanding), so
 * `stage`/`stage_state`/`stage_skipped`/`attention`/`list_bucket` are
 * always populated and correct for every row and every transition. */
export const featureRuns = (data: DataLayer) => {
  const table = data.table<FeatureRun>("feature_runs", "feature_key");
  return new Proxy(table, {
    get(target, prop) {
      if (prop === "insert") {
        return (row: Partial<FeatureRun>) => target.insert({ ...row, ...projectFeatureRun(row) });
      }
      if (prop === "update") {
        return async (id: unknown, patch: Partial<FeatureRun>) => {
          // Only re-read + reproject when the patch changes a projection input. A projection-irrelevant
          // patch (e.g. an `updated_at`-only poller write) leaves the stored projection correct — the
          // gateway is the sole write path — so skip the extra `get` roundtrip and delegate straight.
          if (!patchAffectsProjection(patch)) return target.update(id, patch);
          const existing = await target.get(id);
          const merged: Partial<FeatureRun> = { ...existing, ...patch };
          return target.update(id, { ...patch, ...projectFeatureRun(merged) });
        };
      }
      // Delegate every other method straight through. Bind functions to the real target so the
      // gateway's private class fields (`#src`) resolve — a Proxy `this` would not carry them.
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

/** Re-project every feature_runs row through the gateway so rows missing any projection column get
 * correct `stage`/`stage_state`/`stage_skipped`/`attention`/`list_bucket`/`escalation_open` values.
 * Catches rows written before migration 039 (the pipeline columns) AND rows written before migration
 * 040 (whose `escalation_open` column is NULL, issue #272). Idempotent and safe to re-run: it
 * re-derives from each row's own stored fields, so a second pass is a no-op. Runs once at boot
 * (pollOnce) — the gateway keeps every future write fresh, so this only needs to catch legacy rows.
 * Reprojecting on a missing `escalation_open` matters for a run parked at a LIVE escalation when
 * migration 040 lands: `pollFeatureEscalations` writes nothing while it stays parked (no change), so
 * without this the fail-closed signal would stay NULL and hide a genuinely-open escalation. */
export async function backfillFeatureStages(data: DataLayer): Promise<number> {
  const table = featureRuns(data);
  const rows = await table.all();
  let stamped = 0;
  for (const row of rows) {
    // Only touch rows the projection has never fully reached — a legacy row whose `stage` (pre-039) or
    // `escalation_open` (pre-040) column is still NULL. The gateway keeps every write fresh, so a
    // fully-projected row needs no re-write; skipping them avoids a full-table rewrite on every boot and
    // keeps `stamped` an honest count of rows actually backfilled (not the total row count).
    if (row.stage != null && row.escalation_open != null) continue;
    // Re-derive the projection from the legacy row's own stored fields and write it. (An empty patch
    // would now short-circuit the projecting proxy — it only reprojects on a projection-input change —
    // so backfill projects explicitly rather than relying on an empty-patch reproject.)
    await table.update(row.feature_key, projectFeatureRun(row));
    stamped++;
  }
  return stamped;
}

/** The deterministic task id for a single-issue run — the implementation agent branches
 * `feat/<task.id>` (see resources/prompts/feature.md), so it MUST be derivable from the issue alone
 * and stable across a resume. The PR is opened on the target repo, so the issue number
 * alone is unambiguous within it. */
export function featureTaskId(issueNumber: number): string {
  return `issue-${issueNumber}`;
}

/** Register/refresh the feature-run aggregate (idempotent on `feature_key`) and start
 * `feature.bpmn`. Mirrors startPlan: an already-running run for the same issue
 * short-circuits; a settled prior run is restarted in place. `baseBranch` is admitted at
 * the operation edge (`admitPlan`, ADR 0003) exactly as the epic path — this seam only
 * normalizes it again defensively before seeding the brief. */
export async function startFeature(
  data: DataLayer,
  engine: EngineClient,
  parsed: ParsedIssue,
  baseBranch: string,
  converge: boolean,
  autoMerge: boolean,
  customInstructions: string | null = null,
) {
  // Operator free-text steering for the implementation agent (issue #172 follow-on): blank/absent →
  // null so the implement task's `appendPrompt` FEEL (`customInstructions = null`) skips the block
  // rather than appending an empty "Operator custom instructions" heading.
  const instructions = typeof customInstructions === "string" && customInstructions.trim() !== ""
    ? customInstructions.trim()
    : null;
  const table = featureRuns(data);
  const existing = await table.get(parsed.planKey);
  if (existing && !FEATURE_TERMINAL_STATUSES.includes(existing.status)) {
    return { featureKey: parsed.planKey, alreadyRunning: true, processKey: existing.process_key };
  }
  const base = normalizeBaseBranch(baseBranch);
  const ts = now();
  // Human-readable identity for the feature grids (issue #248): fetch the issue title best-effort
  // and coalesce to the `owner/repo#N` key so `feature_runs.title` is ALWAYS non-blank (see the
  // interface note); a blank/whitespace fetch counts as missing. A fetch failure never blocks the
  // start (`fetchIssueTitle` returns null on any error).
  const title = coalesceTitle(
    await fetchIssueTitle(parsed.repo, parsed.number, process.env.GITHUB_TOKEN ?? ""),
    parsed.planKey,
  );
  if (existing) {
    await table.update(parsed.planKey, {
      status: "running",
      base_branch: base,
      issue_url: parsed.url,
      title,
      pr_key: null,
      converge: converge ? 1 : 0,
      auto_merge: autoMerge ? 1 : 0,
      outcome: null,
      delivery_label: null,
      // Clear the operator tick-off so a re-dispatched run is NOT silently dropped into History when
      // it next settles: a stale `acknowledged_at` from the prior terminal run would make
      // `deriveListBucket` flip the row to 'history' the moment it completes again, skipping the
      // intended operator dismissal. A fresh run must re-earn its tick-off.
      acknowledged_at: null,
      escalation_question: null,
      escalation_user_task_key: null,
      blocked_user_task_key: null,
      updated_at: ts,
    });
  } else {
    await table.insert({
      feature_key: parsed.planKey,
      repo: parsed.repo,
      issue_number: parsed.number,
      issue_url: parsed.url,
      title,
      base_branch: base,
      status: "running",
      process_key: null,
      pr_key: null,
      converge: converge ? 1 : 0,
      auto_merge: autoMerge ? 1 : 0,
      outcome: null,
      delivery_label: null,
      escalation_question: null,
      escalation_user_task_key: null,
      blocked_user_task_key: null,
      created_at: ts,
      updated_at: ts,
    });
  }
  const { processInstanceKey } = await engine.createInstance({
    processDefinitionId: FEATURE_PROCESS_ID,
    variables: {
      featureKey: parsed.planKey,
      repo: parsed.repo,
      // The parent issue reference (`owner/repo#123`) the agent reads for context (`gh issue view`).
      issue: parsed.planKey,
      issueNumber: parsed.number,
      issueUrl: parsed.url,
      // The single slice the implementation agent builds. `task.prompt` is its primary instruction
      // (resources/prompts/feature.md); `task.id` fixes its deterministic branch `feat/<task.id>` across a
      // resume. Unlike an epic, there is no planner — the whole issue IS the slice.
      task: {
        id: featureTaskId(parsed.number),
        title: parsed.planKey,
        prompt:
          `Implement the GitHub issue ${parsed.planKey} end to end. Read it in full first ` +
          `(\`gh issue view ${parsed.number} -R ${parsed.repo}\`), implement it completely, ` +
          `and open exactly one pull request that closes it.`,
      },
      // Follow-on knobs, read by the record/converge workers. `autoMerge` maps to submitPr's
      // `convergeOnly` (inverted): converge-only stops at `converged`; auto-merge drives the
      // merge-loop. `converge=false` ⇒ merge is moot.
      converge,
      autoMerge,
      // A single-issue feature run OWNS its issue (the whole issue is the slice), so the agent may
      // claim it with a "starting work" comment on a first run (resources/prompts/feature.md). Epic slices
      // (plan-fanout) deliberately DO NOT set this — their `issue` is the shared parent epic, which
      // must never be claimed per-slice.
      claimIssue: true,
      // Seed the agent-result variables so the escalation loop + record worker can reference them
      // before the first `senior:feature` job completes (the harness merges the real values in).
      answer: null,
      status: null,
      question: null,
      summary: null,
      pr: null,
      // Escalation SLA + optional assignee — identical to the epic path (plan-fanout), read by the
      // `feature-escalation` user task's interrupting timer boundary and assignment definition.
      escalationSlaTimeout: ESCALATION_SLA_TIMEOUT,
      escalationAssignee: null,
      // Base branch (ADR 0003): the branch the agent branches off and opens its PR against. The
      // brief rides `appendPrompt` in the implement task, exactly like the epic implementer.
      baseBranch: base,
      baseBranchBrief: renderBaseBranchBrief(base),
      // Optional operator steering, appended to the implement agent's prompt via the implement
      // task's `appendPrompt` FEEL (feature.bpmn). Null when none was supplied; persists on the
      // instance so it also rides the answer-loop redispatch back into the same implement task.
      customInstructions: instructions,
    },
  });
  const processKey = processInstanceKey == null ? null : String(processInstanceKey);
  if (processKey != null) {
    await table.update(parsed.planKey, { process_key: processKey, updated_at: now() });
  }
  return { featureKey: parsed.planKey, processKey };
}
