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

/** `status IN (…)` as a closed-DSL predicate: an OR of equalities over the base row's `status`. */
const statusIn = (...statuses: readonly string[]): Expr => or(...statuses.map((s) => eq(col("status"), lit(s))));

/** The terminal tier — the row's `status` is one of the 6 `Done` statuses. */
const isDone: Expr = statusIn(...STAGE_DONE_STATUSES);

/** The canonical pipeline `stage`. TOTAL over all 11 statuses. Terminal → `Done`; else `converging`
 * → `Converging`; else a raised PR (`pr_key` set, mirroring `(pr_key ?? "") !== ""`) or `opened` →
 * `PR open`; else a live/parked implementation status → `Implementing`; else `Requested`. */
const stage: Expr = caseWhen(
  [
    when(isDone, lit("Done")),
    when(eq(col("status"), lit("converging")), lit("Converging")),
    when(or(neq(col("pr_key"), lit("")), eq(col("status"), lit("opened"))), lit("PR open")),
    when(statusIn("running", "escalated", "awaiting_operator"), lit("Implementing")),
  ],
  lit("Requested"),
);

/** The active stage's render state in the `kind:"pipeline"` column's vocabulary: `ok` (merged/
 * converged), `blocked` (terminal blocked), `failed` (failed/skipped/abandoned), else NULL (in
 * progress). A pure function of `status`, so it is correct even for a parked/live status (NULL). */
const stageState: Expr = caseWhen(
  [
    when(statusIn("merged", "converged"), lit("ok")),
    when(eq(col("status"), lit("blocked")), lit("blocked")),
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

/** `<col> IS NOT NULL` in the closed DSL, which has no dedicated null-test operator: a SELF-equality.
 * `eq` collapses a nullish operand to false in BOTH backends (`COALESCE(x = x, 0)` in SQL, the nullish
 * guard in `compareValues` for TS), and any NON-null value equals itself, so this is true IFF the column
 * is non-NULL — faithful to 073/075's `acknowledged_at IS NOT NULL` and free of the SQLite string→number
 * truthiness coercion a bare `col(...)` boolean predicate would otherwise rely on (e.g. `''`/`'abc'`). */
const isNotNull = (name: string): Expr => eq(col(name), col(name));

/** The Active/History partition: `history` IFF the row is in a truly-terminal status AND has been
 * acknowledged; otherwise `active` (live runs + terminal-but-UNACKNOWLEDGED runs). `acknowledged_at IS
 * NOT NULL` is expressed via {@link isNotNull} so it stays byte-equivalent to 073/075's VIEW and does
 * not depend on string→number coercion in either backend. */
const listBucket: Expr = caseWhen([when(and(isDone, isNotNull("acknowledged_at")), lit("history"))], lit("active"));

/** The keys of {@link featureReadModel}'s DERIVED columns, in the order migration 076 emits them.
 * Base columns are identity pass-throughs (not derivations) and are listed in the migration directly. */
export const FEATURE_READ_MODEL_DERIVED = ["stage", "stage_state", "stage_skipped", "attention", "list_bucket"] as const;
export type FeatureReadModelDerivedColumn = (typeof FEATURE_READ_MODEL_DERIVED)[number];

/**
 * The declare-once `feature_read_model` derived columns. `selectBaseColumns: false` because the base
 * columns are plain identity pass-throughs enumerated in migration 076 (so the static pages↔schema
 * contract guard, which reads a VIEW's columns off an aliased select-list, sees them); this model owns
 * only the five real DERIVATIONS. Both the migration VIEW (`sqlSelectFor`, drift-guarded) and the
 * runtime TS oracle (`fnFor`, behind app/stage.ts) are generated from THIS single declaration.
 */
export const featureReadModel: ReadModel = defineReadModel({
  name: "feature_read_model",
  baseTable: "feature_runs",
  selectBaseColumns: false,
  derive: {
    stage,
    stage_state: stageState,
    stage_skipped: stageSkipped,
    attention,
    list_bucket: listBucket,
  },
});

/** The base alias the managed VIEW gives `feature_runs` — pinned so the emitted derived-column SQL
 * (`fr."col"`) matches migration 076 exactly (the drift guard compares against this alias). */
export const FEATURE_READ_MODEL_BASE_ALIAS = "fr";
