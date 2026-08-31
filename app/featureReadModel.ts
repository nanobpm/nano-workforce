// The `feature_read_model` derived read model — DECLARED ONCE and compiled to BOTH backends via
// Urban's ADR-0065 reconciling-read-model primitive (`defineReadModel`, `@nanobpm/urban`).
//
// Background (issues #412 → #439 → #422). The Feature Runs surface renders DERIVED state — a run's
// pipeline `stage`, its `stage_state`/`stage_skipped`, its `attention` badge, its Active/History
// `list_bucket`. None of these are ground truth: each is a pure function of the row's own
// `status`/`pr_key`/`converge`/`auto_merge`/`acknowledged_at` plus, for `attention`, the engine's
// open-user-task set. #412/#439 retired the WRITE-TIME denormalised projection into a SQLite VIEW
// (`feature_read_model`) so no writer can freeze a stored column; #458 (migration 075) then re-pointed
// `attention` off the drift-prone `status` variable onto ENGINE TRUTH — an OPEN `user_tasks` row.
//
// Two drift surfaces survived that hand-wired VIEW (ADR-0065, nano-ide#452):
//   * #2 — every derived column was authored TWICE: the SQL `CASE`/`EXISTS` inside the migration VIEW
//     AND the TypeScript oracle (`deriveStage`/`deriveListBucket`, app/stage.ts), kept in lockstep by
//     a hand-written parity test. The lockstep test does not remove the duplication; it only alarms
//     when the two copies diverge.
//   * #3 — the migration, the VIEW DDL and the parity test were all hand-wired per projection.
//
// This module closes surface #2 STRUCTURALLY (ADR-0065 rollout step 2 — "declare once → compile to
// both", no engine-truth change): each derivation is expressed ONCE in Urban's closed expression DSL,
// and Urban compiles it to BOTH the SQLite VIEW select-list (`sqlSelectFor` — emitted verbatim into
// migration 076, drift-guarded) AND the runtime TS function (`fnFor` — the sole engine behind the
// `deriveStage`/`deriveListBucket` adapters in app/stage.ts). There is nothing left to keep in
// lockstep: the two lowerings fall out of the SAME AST, and `assertReadModelParity` (app/
// featureReadModel.test.ts) is now a framework-owned regression guard that the two lowerings agree,
// not an app-authored mirror of two hand-maintained copies.
//
// SCOPE (step 2). The `attention` derivation reads the app's own `user_tasks` inbox by name (the same
// engine-truth source migration 075 used) via the DSL's `exists(...)`; promoting that to the framework
// canonical `urban_open_user_tasks` projection and inverting `instanceTracking` writer→source are the
// LATER ADR-0065 rollout steps (3/4), deliberately out of scope here.

import { and, caseWhen, col, defineReadModel, type Expr, eq, exists, lit, neq, not, or, pcol, type ReadModel, when } from "@nanobpm/urban";
import { deriveAckOpenExpr, deriveListBucketExpr } from "./listBucket.ts";

/** The 6 TRULY-terminal statuses that map to the `Done` stage — the single source of truth for the
 * terminal tier of BOTH the pipeline `stage`/`stage_state` derivations and the `list_bucket` history
 * partition. Distinct from `FEATURE_TERMINAL_STATUSES` (app/feature.ts), the redispatch-settled set,
 * which also counts `opened`/`converging` as terminal — those are LIVE pipeline stages (`PR open`/
 * `Converging`), NOT `Done`, so the two lists must stay separate. Re-exported from app/stage.ts for
 * back-compat with its existing importers. */
export const STAGE_DONE_STATUSES: readonly string[] = ["merged", "converged", "blocked", "failed", "skipped", "abandoned"];

/** The DSL projection name the `attention` derivation `exists(...)`-reads. Unregistered in the
 * `projectionRegistry`, so it resolves to the same-named physical table — the app's own `user_tasks`
 * inbox (034_user_tasks_inbox.sql), reconciled by `pollUserTasks` (app/service.ts): a row exists IFF a
 * native operator user task is currently OPEN, deleted the moment it closes. (ADR-0065 step 3 will
 * promote this to the framework's canonical `urban_open_user_tasks` projection.) */
export const USER_TASKS_PROJECTION = "user_tasks";

/** The base table the read model reads: the auto-provisioned `feature_runs__tracking` derived VIEW
 * (ADR-0065, urban 0.81.0), NOT the raw `feature_runs` table. The VIEW re-exports `feature_runs.*`
 * plus a `derived_status` column that folds the `instanceTracking` reconciler's terminal edge
 * (out-of-band terminate / in-app cancel → `abandoned`) over the worker-owned transient `status`. The
 * status-classifying derivations below read `derived_status`, so a terminated run renders `Done`/
 * `failed` instead of freezing at its last transient (`Implementing` forever — issue #503). The
 * non-status base columns (`pr_key`/`converge`/`auto_merge`/`acknowledged_at`/`feature_key`) come off
 * the same VIEW's pass-through of `base.*`. */
export const FEATURE_READ_MODEL_BASE_TABLE = "feature_runs__tracking";

/** The effective-status column the status-classifying derivations read: the tracking VIEW's ADR-0065
 * `derived_status` (terminal-folded), NOT the frozen base `status`. Single source of truth for the
 * column name so the derivations can't drift from it. */
export const EFFECTIVE_STATUS_COLUMN = "derived_status";

/** `derived_status IN (…)` as a closed-DSL predicate: an OR of equalities over the tracking VIEW's
 * terminal-folded effective status. */
const statusIn = (...statuses: readonly string[]): Expr =>
  or(...statuses.map((s) => eq(col(EFFECTIVE_STATUS_COLUMN), lit(s))));

/** The terminal tier — the row's effective (terminal-folded) status is one of the 6 `Done` statuses. */
const isDone: Expr = statusIn(...STAGE_DONE_STATUSES);

/** The canonical pipeline `stage`. TOTAL over all 11 statuses. Terminal → `Done`; else `converging`
 * → `Converging`; else a raised PR (`pr_key` set, mirroring `(pr_key ?? "") !== ""`) or `opened` →
 * `PR open`; else a live/parked implementation status → `Implementing`; else `Requested`. Classifies
 * on the terminal-folded `derived_status` so a cancelled/terminated run is `Done`, not frozen. */
const stage: Expr = caseWhen(
  [
    when(isDone, lit("Done")),
    when(eq(col(EFFECTIVE_STATUS_COLUMN), lit("converging")), lit("Converging")),
    when(or(neq(col("pr_key"), lit("")), eq(col(EFFECTIVE_STATUS_COLUMN), lit("opened"))), lit("PR open")),
    when(statusIn("running", "escalated", "awaiting_operator"), lit("Implementing")),
  ],
  lit("Requested"),
);

/** The active stage's render state in the `kind:"pipeline"` column's vocabulary: `ok` (merged/
 * converged), `blocked` (terminal blocked), `failed` (failed/skipped/abandoned), else NULL (in
 * progress). A pure function of the terminal-folded `derived_status`, so a terminated run renders a
 * terminal `failed` state instead of a frozen NULL. */
const stageState: Expr = caseWhen(
  [
    when(statusIn("merged", "converged"), lit("ok")),
    when(eq(col(EFFECTIVE_STATUS_COLUMN), lit("blocked")), lit("blocked")),
    when(statusIn("failed", "skipped", "abandoned"), lit("failed")),
  ],
  lit(null),
);

/** The space-separated set of pipeline stages NOT in this row's path, purely from `converge`/
 * `auto_merge`: no converge ⇒ both `Converging` and `Merging` are skipped; converge but no auto-merge
 * ⇒ only `Merging`; else none. (`not(col(...))` mirrors the TS `!truthy(...)` under the shared
 * "NULL → false" rule.) */
const stageSkipped: Expr = caseWhen(
  [
    when(not(col("converge")), lit("Converging Merging")),
    when(not(col("auto_merge")), lit("Merging")),
  ],
  lit(""),
);

/** The correlation predicate for an OPEN operator user task of `elementId` on this feature run: a
 * `user_tasks` row keyed `subject_type='feature'`, `subject_key=<this row's feature_key>` (how
 * `pollUserTasks` keys them — app/service.ts `DEFAULT_SUBJECT_TYPE`/`contextFor`). */
const openTaskWhere = (elementId: string): Expr =>
  and(eq(pcol("subject_type"), lit("feature")), eq(pcol("subject_key"), col("feature_key")), eq(pcol("element_id"), lit(elementId)));

/** The `attention` badge, derived from ENGINE TRUTH — the presence of an OPEN native user task — NOT
 * from the drift-prone `status` variable (issue #422). `blocked` glyph IFF an open `feature-blocked`
 * task exists; `⚠` IFF an open `feature-escalation` task exists; else no badge. Once a task is
 * answered its `user_tasks` row is gone, so the badge clears immediately even while `status` still
 * reads a stale `"escalated"` on the answer-loop back into `implement-task`. */
const attention: Expr = caseWhen(
  [
    when(exists(USER_TASKS_PROJECTION, openTaskWhere("feature-blocked")), lit("blocked")),
    when(exists(USER_TASKS_PROJECTION, openTaskWhere("feature-escalation")), lit("⚠")),
  ],
  lit(null),
);

/** The Active/History partition: `history` IFF the row is in a truly-terminal status AND has been
 * acknowledged; otherwise `active` (live runs + terminal-but-UNACKNOWLEDGED runs). Delegates to the ONE
 * shared `deriveListBucketExpr` oracle (app/listBucket.ts, issue #641) parameterised by the feature
 * terminal set ({@link STAGE_DONE_STATUSES}) so all four "Active …" grids share the identical AST — the
 * emitted SQL stays byte-equivalent to migration 081's already-merged VIEW body (the shared oracle
 * reproduces this model's `isDone`/`isNotNull` forms exactly). */
const listBucket: Expr = deriveListBucketExpr(EFFECTIVE_STATUS_COLUMN, STAGE_DONE_STATUSES);

/** The operator "Dismiss" (tick-off) affordance flag — `1` IFF the run is terminal AND not yet
 * acknowledged (so the page's `showWhenField` Dismiss button renders only for a terminal-but-
 * unacknowledged run), else `0`. The feature twin of the PR/Delivery-Graph/Epic `ack_open`, from the
 * ONE shared oracle (app/listBucket.ts, issue #641) parameterised by the SAME {@link
 * STAGE_DONE_STATUSES} terminal set `list_bucket` uses — so the Dismiss button and the
 * `acknowledgeDone` guard consume the identical predicate and cannot drift (issue #654). */
const ackOpen: Expr = deriveAckOpenExpr(EFFECTIVE_STATUS_COLUMN, STAGE_DONE_STATUSES);

/** The keys of {@link featureReadModel}'s DERIVED columns, in the order migration 099 emits them.
 * Base columns are identity pass-throughs (not derivations) and are listed in the migration directly. */
export const FEATURE_READ_MODEL_DERIVED = ["stage", "stage_state", "stage_skipped", "attention", "list_bucket", "ack_open"] as const;
export type FeatureReadModelDerivedColumn = (typeof FEATURE_READ_MODEL_DERIVED)[number];

/**
 * The declare-once `feature_read_model` derived columns. `selectBaseColumns: false` because the base
 * columns are plain identity pass-throughs enumerated in migration 076 (so the static pages↔schema
 * contract guard, which reads a VIEW's columns off an aliased select-list, sees them); this model owns
 * only the six real DERIVATIONS. Both the migration VIEW (`sqlSelectFor`, drift-guarded) and the
 * runtime TS oracle (`fnFor`, behind app/stage.ts) are generated from THIS single declaration.
 */
export const featureReadModel: ReadModel = defineReadModel({
  name: "feature_read_model",
  baseTable: FEATURE_READ_MODEL_BASE_TABLE,
  selectBaseColumns: false,
  derive: {
    stage,
    stage_state: stageState,
    stage_skipped: stageSkipped,
    attention,
    list_bucket: listBucket,
    ack_open: ackOpen,
  },
});

/** The base alias the managed VIEW gives `feature_runs` — pinned so the emitted derived-column SQL
 * (`fr."col"`) matches migration 076 exactly (the drift guard compares against this alias). */
export const FEATURE_READ_MODEL_BASE_ALIAS = "fr";
