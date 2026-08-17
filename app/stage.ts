// Canonical feature-run pipeline stage model (issue #254 §1) — the ONE source of truth for the
// derived pipeline surface the Feature view renders. Mirrors the single-source-of-truth style of
// `deriveDelivery` (app/delivery.ts) and `classifyEscalation` (app/escalationTaxonomy.ts): a PURE,
// read-only function with no data access. The feature_runs gateway (app/feature.ts) projects its
// output onto the stored `stage`/`stage_state`/`stage_skipped`/`attention` columns at write time,
// exactly as `delivery_label` is projected — so the declarative dataGrid page consumes ready, stored
// columns (bound by `{"field":…}`) and never has to call TS or express OR/null in its flat filter DSL.
//
// The mapping is TOTAL and DETERMINISTIC over all 11 FEATURE_RUN_STATUSES, computed from ONLY the
// fields stored on the row — never a "previous"/"underlying" stage, because a FeatureRun stores only
// its CURRENT status (any prior stage was overwritten on transition). Do NOT duplicate this mapping
// anywhere (not in SQL, not in the page, not in each poller/worker): every writer flows through the
// gateway, which is the single caller.

/** The canonical pipeline stage keys, in path order. `Merging` is a path/visual stage the renderer
 * fills as upcoming — no status maps to it as the ACTIVE stage (intentional). */
export const STAGE_KEYS = ["Requested", "Implementing", "PR open", "Converging", "Merging", "Done"] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

/** The active stage's render state, in the urban 0.53.0 `kind:"pipeline"` column's EXACT vocabulary:
 * `ok` (Done ✓ success), `failed` (Done ✕ failure), `blocked` (blocked glyph), or `null` (in-progress
 * → the renderer treats it as `active`). Any OTHER string silently degrades to `active` in the
 * renderer, so a failed run MUST emit `'failed'` (not `'fail'`) to render as a failure. */
export type StageState = "ok" | "failed" | "blocked" | null;

/** The 6 TRULY-terminal statuses that map to the `Done` stage. Distinct from
 * `FEATURE_TERMINAL_STATUSES` (app/feature.ts), which is the redispatch-settled set and also counts
 * `opened`/`converging` as terminal — those are LIVE pipeline stages (`PR open`/`Converging`), NOT
 * Done, so this list must stay separate. Also the basis of the `list_bucket` history partition. */
export const STAGE_DONE_STATUSES: readonly string[] = [
  "merged",
  "converged",
  "blocked",
  "failed",
  "skipped",
  "abandoned",
];

/** The subset of a FeatureRun `deriveStage` reads. FeatureRun (app/feature.ts) structurally satisfies
 * this; keeping the input structural avoids a stage.ts ↔ feature.ts import cycle. */
export interface StageInput {
  status: string;
  pr_key?: string | null;
  converge?: number | boolean | null;
  auto_merge?: number | boolean | null;
  escalation_question?: string | null;
  escalation_user_task_key?: string | null;
  blocked_user_task_key?: string | null;
}

/** The derived pipeline projection for one run. `skipped` is a space-separated set of stage keys not
 * in this row's path (bound to the renderer's `notInPathField`). */
export interface DerivedStage {
  stage: StageKey;
  state: StageState;
  skipped: string;
  attention: string | null;
}

const truthy = (v: number | boolean | null | undefined): boolean => v === true || (typeof v === "number" && v !== 0);

/** Derive the canonical pipeline stage, its render state, its not-in-path set, and its attention badge
 * for one feature run. Pure and read-only — TOTAL over all 11 statuses (never returns undefined). */
export function deriveStage(run: StageInput): DerivedStage {
  const { status } = run;

  // TERMINAL tier — the 6 truly-terminal statuses collapse to Done. Unconditional: terminal `blocked`
  // is the issue §1 'Done ✕' row (state `blocked`), NOT Implementing.
  let stage: StageKey;
  let state: StageState;
  if (STAGE_DONE_STATUSES.includes(status)) {
    stage = "Done";
    state =
      status === "merged" || status === "converged"
        ? "ok"
        : status === "blocked"
          ? "blocked"
          : "failed"; // failed / skipped / abandoned
  } else {
    // LIVE/PARKED tier — one shared rule for every non-terminal status. `escalated`/`awaiting_operator`
    // are parked but their stored fields still describe WHERE in the pipeline they stalled, so they run
    // through the same rule as a live run; their attention comes from the badge (below), not the stage.
    if (status === "converging") stage = "Converging";
    else if ((run.pr_key ?? "") !== "" || status === "opened") stage = "PR open";
    else if (status === "running" || status === "escalated" || status === "awaiting_operator") stage = "Implementing";
    else stage = "Requested";
    state = null;
  }

  // `skipped`: stages not in this row's path, purely from converge/auto_merge.
  const converge = truthy(run.converge);
  const autoMerge = truthy(run.auto_merge);
  const skippedKeys: StageKey[] = !converge ? ["Converging", "Merging"] : !autoMerge ? ["Merging"] : [];

  // `attention`: a short badge for the active stage (the renderer colours it from `state`). This is how
  // a parked `awaiting_operator`/`escalated` run surfaces as attention WITHOUT altering its stage.
  const attention = run.blocked_user_task_key
    ? "blocked"
    : run.escalation_user_task_key || run.escalation_question
      ? "⚠"
      : null;

  return { stage, state, skipped: skippedKeys.join(" "), attention };
}

/** Derive the single fail-closed "open escalation" display signal for one feature run (issue #272).
 *
 * The open-escalation condition is jointly encoded by THREE independently-written columns —
 * `status='escalated'`, `escalation_user_task_key` (the completable pointer), and `escalation_question`
 * — owned by different writers on different schedules (the `record-feature-escalation` service task
 * sets the question; `pollFeatureEscalations`/`deriveFeatureEscalationPatch` sets status + pointer; the
 * answer operation clears the tuple). Because they are not written as one atomic tuple, a reader can
 * observe a TORN interim state (e.g. `status=escalated` + pointer set + `question=null`) and render a
 * self-contradictory escalation — an "answer me" affordance with nothing to answer.
 *
 * Collapse that class at the consumer: the pages gate the escalation affordances (Abandon / answer
 * form) on this ONE derived conjunction rather than on any single column, so a torn tuple renders as
 * NOT escalated (fail closed) instead of escalated-but-blank. `true` iff ALL THREE fields agree the run
 * is parked at an answerable escalation; any missing field yields `false`. Maintained as a write-time
 * projection by the feature_runs gateway (like `stage`/`list_bucket`), so it stays fresh on every write
 * — including the answer operation's eager tuple-clear, which makes the affordance disappear WITHOUT
 * waiting a poll pass. Pure and read-only. */
export function deriveEscalationOpen(run: {
  status: string;
  escalation_question?: string | null;
  escalation_user_task_key?: string | null;
}): boolean {
  return (
    run.status === "escalated" &&
    (run.escalation_user_task_key ?? "") !== "" &&
    (run.escalation_question ?? "") !== ""
  );
}

/** The Active/History partition label (§5), maintained at write time so the flat-DSL page tabs filter
 * on a stored `list_bucket` column with only `in` clauses. `history` iff the row is in a truly-terminal
 * status AND acknowledged; otherwise `active` (live runs + terminal-but-UNACKNOWLEDGED runs). */
export function deriveListBucket(status: string, acknowledgedAt: string | null | undefined): "active" | "history" {
  return STAGE_DONE_STATUSES.includes(status) && acknowledgedAt != null ? "history" : "active";
}
