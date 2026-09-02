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
import { TRANSCRIPT_URL_BASE_VAR, transcriptUrlBaseFor } from "./agentic/transcript-url.ts";
import { coalesceTitle, fetchIssueTitle } from "./github.ts";
import { derivedTrackingTable } from "./instanceTracking.ts";
import { ESCALATION_SLA_TIMEOUT, normalizeBaseBranch, type ParsedIssue, renderBaseBranchBrief } from "./plan.ts";
import type { ReadinessProbe } from "./readiness.ts";
import { repoEnvelopeVars } from "./repoEnvelope.ts";

/** Optional intake-time readiness gate for a feature run (issue #295): the `capability`/`command`/…
 * probes the run must ALL satisfy before its implementation agent is dispatched (parked, durably, at
 * the leading readiness preflight in feature.bpmn), plus the single ISO-8601 bound the preflight's
 * escalation timers fire off. Both are DERIVED once from the submitted `readiness`/`blockedOn` intake
 * by {@link parseFeatureReadiness} (app/featureReadiness.ts). Empty/absent ⇒ the gate is skipped and
 * the run proceeds straight to implementation, exactly as today's submissions do. */
export interface FeatureReadinessOptions {
  readonly probes?: ReadinessProbe[];
  readonly probeTimeout?: string | null;
  readonly probePollEvery?: string | null;
}

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
  /** Timestamp an operator dismissed a TERMINAL run (§5, `acknowledge-done`); NULL until then. When
   * set on a terminal row, `list_bucket` flips from 'active' to 'history'. Projection surface. */
  acknowledged_at: string | null;
  /** RETIRED as a write-time projection (issue #439): the pipeline `stage` is now DERIVED by the
   * `feature_read_model` VIEW (073) from `status`/`pr_key`/`converge`/`auto_merge`, mirroring
   * `deriveStage` (app/stage.ts). The Feature page binds the VIEW's `stage`, never this base column,
   * so a raw-datasource `status` write (the `instanceTracking` reconciler) can no longer leave it
   * stale. The base column survives (expand/contract — a later migration drops it) but is no longer
   * written or read; NULL on rows written after the projection was removed. */
  stage: string | null;
  /** RETIRED as a write-time projection (issue #439): `stage_state` is DERIVED by `feature_read_model`
   * (073). See `stage`. The page binds the VIEW's `stateField`; this base column is vestigial. */
  stage_state: string | null;
  /** RETIRED as a write-time projection (issue #439): `stage_skipped` is DERIVED by `feature_read_model`
   * (073). See `stage`. The page binds the VIEW's `notInPathField`; this base column is vestigial. */
  stage_skipped: string | null;
  /** RETIRED as a write-time projection (issue #439): `attention` is DERIVED by `feature_read_model`
   * (073). See `stage`. The page binds the VIEW's `badgeField`; this base column is vestigial. */
  attention: string | null;
  /** RETIRED as a write-time projection (issue #439): the Active/History `list_bucket` ('active'|
   * 'history', 'history' iff a terminal row is acknowledged) is DERIVED by `feature_read_model` (073)
   * from `status`/`acknowledged_at`, mirroring `deriveListBucket`. The page's tabs filter the VIEW's
   * `list_bucket`; this base column is vestigial. */
  list_bucket: string | null;
  created_at: string;
  updated_at: string;
}

export const FEATURE_RUN_STATUSES = [
  "running", // the agent is implementing
  "escalated", // NON-terminal: the run is parked at the `feature-escalation` operator user task,
  // waiting on a human answer (set by record-feature-escalation; surfaced on the Tasks inbox by pollUserTasks)
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
 * parks on when the agent escalates. `pollUserTasks` reads the engine's open task for this element to
 * project it onto the `user_tasks` Tasks inbox. */
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
  /** The engine `jobKey` that wrote the row — an idempotency guard so a `record-feature-escalation`
   *  job retried after its insert (crash/timeout pre-completion) reuses its row instead of appending a
   *  duplicate (mirrors `plan_reviews.job_key`). NULL only for migration-048 backfill rows. */
  job_key: string | null;
}

/** Accessor for the append-only `feature_escalations` audit log (migration 048). Written by
 *  `record-feature-escalation` (one row per escalation entry), read by `pollUserTasks` to enrich the
 *  open `feature-escalation` task's question — the feature analogue of `plan_reviews` / `escalations`. */
export const featureEscalations = (data: DataLayer) =>
  data.table<FeatureEscalationRow>("feature_escalations", "id");

/** Append one `feature_escalations` audit row capturing the agent's escalation `question` while it is
 *  still in scope on the `record-feature-escalation` job. Append-only, so this is the canonical record
 *  of what was asked — `pollUserTasks` reads the newest row per feature as the live question. The
 *  `jobKey` is an idempotency guard: `record-feature-escalation` is at-least-once, so a retry after the
 *  insert (crash/timeout pre-completion) re-runs with the SAME `jobKey` and must reuse the existing row
 *  rather than append a duplicate (mirrors `record-plan-review` guarding `plan_reviews` by `job_key`). */
export async function recordFeatureEscalation(
  data: DataLayer,
  entry: { featureKey: string; question: string | null; jobKey: string },
): Promise<void> {
  const table = featureEscalations(data);
  // A prior attempt of THIS job already recorded its row — reuse it, don't append a duplicate.
  if (await table.findOne({ feature_key: entry.featureKey, job_key: entry.jobKey })) return;
  await table.insert({
    feature_key: entry.featureKey,
    question: entry.question,
    created_at: new Date().toISOString(),
    job_key: entry.jobKey,
  });
}

/** The `feature-blocked` user-task element id (feature.bpmn) — the native operator wait a run parks on
 * when the agent reports a `blocked` outcome (it gave up / the escalation was abandoned or timed out).
 * `pollUserTasks` reads the engine's open task for this element to project it onto the `user_tasks`
 * Tasks inbox. */
export const FEATURE_BLOCKED_ELEMENT = "feature-blocked";

/** The feature_runs record gateway (keyed on `feature_key`) — a plain record table.
 *
 * The pipeline projection (`stage`/`stage_state`/`stage_skipped`/`attention`/`list_bucket`) is NO
 * LONGER a write-time projection here (issue #439): it is a DERIVED SQL VIEW, `feature_read_model`
 * (073), computed from each row's own `status`/`pr_key`/`converge`/`auto_merge`/`acknowledged_at`. The
 * Feature page binds the VIEW, never this table's stored derived columns. Removing the write-time
 * projection closes the drift the framework `instanceTracking` reconciler opened: it writes
 * `feature_runs.status` through the RAW datasource (`{status:"abandoned"}` on a terminated instance),
 * bypassing the old projecting gateway and leaving the display columns frozen — now there is no stored
 * derived column and no write-path for any writer to leave stale. `deriveStage`/`deriveListBucket`
 * (app/stage.ts) remain the canonical implementation the VIEW mirrors and the acknowledge operations
 * reuse; app/featureReadModel.test.ts pins the VIEW to them (including a raw-datasource `status` write
 * that reproduces the reconciler bypass). */
export const featureRuns = (data: DataLayer) => data.table<FeatureRun>("feature_runs", "feature_key");

/** A `feature_runs` row as seen through its derived tracking VIEW (`feature_runs__tracking`): the base
 * columns plus urban's ADR-0065 `derived_status`, which FOLDS the reconciler's terminal edge
 * (out-of-band terminate / in-app cancel → `abandoned`) over the worker-owned transient. Since urban
 * 0.81.0 the `instanceTracking` reconciler is a SOURCE, not a writer: it no longer stamps the terminal
 * onto base `status` on cancel/terminate — the terminal is recomputed on read as `derived_status`. */
export type TrackedFeatureRun = FeatureRun & { derived_status: string };

/** Read-only accessor over the feature-run derived tracking VIEW (`feature_runs__tracking`). Use this —
 * and read `derived_status`, NOT the base `status` — for the intake/admission idempotency
 * classification (issue #704), so a run whose engine instance was terminated out-of-band (base row
 * frozen at its last transient `running`/`escalated`/`awaiting_operator`) is correctly seen as
 * `abandoned` and RESUBMITTABLE. The view name + `derived_status` column resolve through
 * `derivedTrackingTable` (app/instanceTracking.ts), never a hard-coded name — mirroring `prsTracking`
 * (app/service.ts) and `plansTracking` (app/plan.ts). Writes stay on `featureRuns`. */
export const featureRunsTracking = (data: DataLayer) =>
  derivedTrackingTable<TrackedFeatureRun>(data, "feature_runs", "feature_key");

/** The discriminated outcome of a feature-run intake (issue #704). It distinguishes a genuine dispatch
 * from a short-circuit and from a no-op, so a submit that started NOTHING can never render as a bare
 * green success:
 *  - `started` — a fresh engine instance was dispatched (`processKey` set).
 *  - `already-active` — a non-terminal prior run for the same issue is still live, so the start
 *    short-circuited; no new instance was created and `processKey` is the live run's.
 *  - `noop-terminal` — the intake attempted a start but the engine returned NO instance key, so
 *    nothing was dispatched. Surfaced by the operation as a distinct non-success (a submit that
 *    dispatches no instance is not "Done"). */
export type FeatureStartOutcome = "started" | "already-active" | "noop-terminal";

/** The result of {@link startFeature} — a discriminated intake outcome (issue #704). `alreadyRunning`
 * is retained as a back-compat flag for existing callers/telemetry (true iff `outcome` is
 * `already-active`). A `type` alias (not an `interface`) because an object-literal type alias — with a
 * fully-known, final set of properties — is assignable to the generated OpenAPI response shape's index
 * signature, whereas an `interface` (open to declaration-merging) is not; this mirrors the inferred
 * sibling results. */
export type StartFeatureResult = {
  featureKey: string;
  outcome: FeatureStartOutcome;
  /** The dispatched instance key (`started`), the live run's key (`already-active`), or null
   * (`noop-terminal`). */
  processKey: string | null;
  /** True iff a non-terminal prior run short-circuited the start (`outcome === "already-active"`). */
  alreadyRunning: boolean;
};

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
  readiness: FeatureReadinessOptions = {},
): Promise<StartFeatureResult> {
  // Intake-time readiness gate (issue #295): the probes the run must satisfy before it implements,
  // and the bound its preflight escalation timers fire off. Both are load-bearing together —
  // `pr.readiness-probe` rejects a blank `probeTimeout` and the preflight timers read `=probeTimeout`
  // — so a non-empty probe set seeded without a bound would incident at runtime. Fail fast at the
  // start door instead (mirroring `startPlan`); `parseFeatureReadiness` always derives the two
  // together, so this only fires for a mis-seeded direct caller.
  const readinessProbes = readiness.probes && readiness.probes.length > 0 ? readiness.probes : null;
  if (readinessProbes && (readiness.probeTimeout ?? "").trim() === "") {
    throw new Error(
      `startFeature(${parsed.planKey}): ${readinessProbes.length} readiness probe(s) seeded without a ` +
        "probeTimeout — the preflight escalation timers (=probeTimeout) and pr.readiness-probe both require " +
        "a non-blank bound. Derive it via parseFeatureReadiness before starting a gated feature.",
    );
  }
  if (readinessProbes && (readiness.probePollEvery ?? "").trim() === "") {
    throw new Error(
      `startFeature(${parsed.planKey}): ${readinessProbes.length} readiness probe(s) seeded without a ` +
        "probePollEvery — the preflight retry timers (=probePollEvery) require a non-blank cadence. " +
        "Derive it via parseFeatureReadiness before starting a gated feature.",
    );
  }
  // Operator free-text steering for the implementation agent (issue #172 follow-on): blank/absent →
  // null so the implement task's `appendPrompt` FEEL (`customInstructions = null`) skips the block
  // rather than appending an empty "Operator custom instructions" heading.
  const instructions = typeof customInstructions === "string" && customInstructions.trim() !== ""
    ? customInstructions.trim()
    : null;
  const table = featureRuns(data);
  // ADR-0065: classify "already running" on the DERIVED terminal edge, not the base transient. A
  // feature run whose engine instance was terminated out-of-band (or by an ordinary in-app cancel —
  // derive-only under urban 0.81.0) has a base row frozen at its last worker transient
  // (`running`/`escalated`/`awaiting_operator`) but a `feature_runs__tracking.derived_status` of
  // `abandoned`. Reading the base `status` here wedged a terminated run `alreadyRunning` forever —
  // returning a green success while dispatching NO instance (issue #704, the feature-side twin of the
  // `submitPr` / epic re-admission wedges #503 fixed; this intake reader was the one #503 omitted).
  // Route the idempotency gate through the derived view so a terminated run is correctly seen terminal
  // and RESUBMITTABLE; a non-terminal derived edge still short-circuits (a genuinely-live run cannot
  // be double-started). ONE read through the tracking VIEW serves both this classification and the
  // insert-vs-update decision below: it re-exports every base column (so it doubles as the "exists?"
  // check and the `process_key` source) plus `derived_status`, so a second base-table round trip is
  // redundant.
  const trackedExisting = await featureRunsTracking(data).get(parsed.planKey);
  // A row with a null `process_key` never had an engine instance dispatched, so it is NEVER a live
  // run — treat it as non-active for admission. This is load-bearing for the `noop-terminal` path
  // (issue #704): a start the engine accepted without returning an instance key leaves a base row at
  // `running`/`process_key: null` whose `derived_status` folds to the non-terminal base `running`
  // (there is no terminated instance to fold to `abandoned`). Without this guard that phantom row
  // would short-circuit every retry as `already-active`, wedging resubmission forever even though
  // nothing was ever dispatched.
  if (
    trackedExisting &&
    trackedExisting.process_key != null &&
    !FEATURE_TERMINAL_STATUSES.some((s) => s === trackedExisting.derived_status)
  ) {
    return {
      featureKey: parsed.planKey,
      outcome: "already-active",
      processKey: trackedExisting.process_key,
      alreadyRunning: true,
    };
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
  if (trackedExisting) {
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
      created_at: ts,
      updated_at: ts,
    });
  }
  const taskId = featureTaskId(parsed.number);
  // Pre-PR feature branch (issue #684): the deterministic `feat/<task.id>` the harness creates off the
  // base for the implementation agent (the agent-guide's `feat/*` convention), matching `task.id`.
  const prePrBranch = `feat/${taskId}`;
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
        id: taskId,
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
      // Intake-time readiness gate (issue #295): the leading preflight the feature run parks on until
      // every declared probe goes green (feature.bpmn `gw-readiness` → `readiness-preflight`). A
      // submission with NO readiness carries `null` here, so the gateway routes straight to
      // `ensure-base-branch` and the run implements immediately — behaviour unchanged for today's
      // features. `probeTimeout` bounds the preflight's escalation timers (derived once from the same
      // probes); `gateKey` is the non-blank correlation key the probe worker publishes
      // `readiness-ready` on (required even in the preflight, which reads the probe's synchronous
      // result); `resolvedArtifacts` is filled by the preflight on green — the exact `pkg@version`s
      // first carrying each awaited capability — and rides the implement task's `appendPrompt` so the
      // agent bumps the consumer dependency to exactly the bound version. Seeded `null` so a
      // gate-less run still resolves the variable in that FEEL instead of raising an incident.
      readinessProbes,
      probeTimeout: readinessProbes ? (readiness.probeTimeout ?? null) : null,
      probePollEvery: readinessProbes ? (readiness.probePollEvery ?? null) : null,
      gateKey: readinessProbes ? `feature-readiness:${parsed.planKey}` : null,
      resolvedArtifacts: null,
      // Stage 0 transcript correlation (#543): the transcript-endpoint base the `implement-task` agent
      // worker appends its jobKey-scoped stream to, to emit a `transcriptUrl` output variable that
      // links this feature run to its agent transcript in Nano Explorer (feature.bpmn `implement-task`
      // ioMapping). Read down into the job via `=transcriptUrlBase`.
      [TRANSCRIPT_URL_BASE_VAR]: transcriptUrlBaseFor(),
      // Host-git provisioning (c8ctl, issue #684): deliver the repository envelope so the
      // `senior:feature` implementation agent gets an ISOLATED throwaway clone instead of inheriting
      // the worker's launch dir (which, with several copilot workers on one host, means concurrent
      // implementation jobs share — and clobber — one checkout, violating the durable-resume design).
      // A feature run is PRE-PR: there is no head branch yet, so the harness checks out the BASE
      // branch (`ref = base`) and creates the deterministic `feat/<task.id>` feature branch itself
      // (`branchCreate`), matching the agent-guide's `feat/*` convention. Spread last so an unresolved
      // repo (`{}`) leaves the other vars untouched.
      ...repoEnvelopeVars(parsed.repo, base, null, null, prePrBranch),
    },
  });
  const processKey = processInstanceKey == null ? null : String(processInstanceKey);
  if (processKey != null) {
    await table.update(parsed.planKey, { process_key: processKey, updated_at: now() });
    return { featureKey: parsed.planKey, outcome: "started", processKey, alreadyRunning: false };
  }
  // The engine accepted the start but returned NO instance key — nothing was actually dispatched.
  // Report a discriminated no-op (issue #704) so the caller can surface it as a distinct non-success
  // instead of a bare green "Done": a submit that dispatches no instance is not "started".
  return { featureKey: parsed.planKey, outcome: "noop-terminal", processKey: null, alreadyRunning: false };
}
