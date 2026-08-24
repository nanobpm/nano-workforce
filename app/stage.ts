// Canonical feature-run pipeline stage model (issue #254 §1) — the ergonomic TS façade over the ONE
// derived-read-model declaration in app/featureReadModel.ts. The pipeline surface the Feature view
// renders (`stage`/`stage_state`/`stage_skipped`/`attention`/`list_bucket`) is DERIVED, never ground
// truth: each column is a pure function of a feature run's own `status`/`pr_key`/`converge`/
// `auto_merge`/`acknowledged_at` plus, for `attention`, the engine's OPEN-user-task set.
//
// SINGLE SOURCE OF TRUTH (ADR-0065, nano-ide#452). These derivations are declared ONCE, in Urban's
// closed expression DSL (`featureReadModel`, app/featureReadModel.ts), and compiled to BOTH the SQLite
// VIEW (migration 076) and the runtime TS functions used here. `deriveStage`/`deriveListBucket` are
// now thin ADAPTERS that evaluate that declaration's compiled functions (`fnFor`) — they do NOT
// re-express the CASE/EXISTS logic in TypeScript, so the SQL and TS lowerings cannot drift (the former
// hand-written parity test becomes the framework-owned `assertReadModelParity` regression guard). The
// mapping remains TOTAL and DETERMINISTIC over all 11 FEATURE_RUN_STATUSES. Do NOT duplicate it
// anywhere (not in SQL, not in the page, not in each poller/worker): every reader flows through the
// VIEW or these adapters, both sourced from the one declaration.

import { EFFECTIVE_STATUS_COLUMN, type FeatureReadModelDerivedColumn, featureReadModel, STAGE_DONE_STATUSES, USER_TASKS_PROJECTION } from "./featureReadModel.ts";

// Re-exported for back-compat with existing importers (operations/acknowledgeDone.ts). Its canonical
// home is now app/featureReadModel.ts, where it feeds the terminal tier of the derived columns.
export { STAGE_DONE_STATUSES };

/** The canonical pipeline stage keys, in path order. `Merging` is a path/visual stage the renderer
 * fills as upcoming — no status maps to it as the ACTIVE stage (intentional). */
export const STAGE_KEYS = ["Requested", "Implementing", "PR open", "Converging", "Merging", "Done"] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

/** The active stage's render state, in the urban `kind:"pipeline"` column's EXACT vocabulary:
 * `ok` (Done ✓ success), `failed` (Done ✕ failure), `blocked` (blocked glyph), or `null` (in-progress
 * → the renderer treats it as `active`). Any OTHER string silently degrades to `active` in the
 * renderer, so a failed run MUST emit `'failed'` (not `'fail'`) to render as a failure. */
export type StageState = "ok" | "failed" | "blocked" | null;

/** The subset of a FeatureRun `deriveStage` reads. FeatureRun (app/feature.ts) structurally satisfies
 * this; keeping the input structural avoids a stage.ts ↔ feature.ts import cycle. */
export interface StageInput {
  status: string;
  pr_key?: string | null;
  converge?: number | boolean | null;
  auto_merge?: number | boolean | null;
  /** Engine truth for the `attention` badge (issue #422): whether an OPEN native user task of each
   * human-wait kind currently exists for this run, from the `user_tasks` inbox (`pollUserTasks`, the
   * authoritative "who is waiting on a human" set). `attention` derives from THESE, never from the
   * drift-prone `status` variable — so once an escalation is answered (its `user_tasks` row deleted)
   * the badge clears immediately even while `status` still reads a stale `"escalated"`. Omitted/false
   * ⇒ no open task ⇒ no badge. These booleans are lowered into synthetic `user_tasks` projection rows
   * so this façade evaluates the SAME `exists(...)` derivation the VIEW compiles. */
  hasOpenBlockedTask?: boolean | null;
  hasOpenEscalationTask?: boolean | null;
}

/** The derived pipeline projection for one run. `skipped` is a space-separated set of stage keys not
 * in this row's path (bound to the renderer's `notInPathField`). */
export interface DerivedStage {
  stage: StageKey;
  state: StageState;
  skipped: string;
  attention: string | null;
}

/** The synthetic correlation key threaded through the `attention` derivation: the base row's
 * `feature_key` and each synthesised open-task row's `subject_key` share this value so the compiled
 * `exists(... WHERE subject_key = feature_key ...)` predicate matches. Its concrete value is
 * immaterial (it never leaves this function); it only has to be consistent between the two. */
const SELF_KEY = "self";

/** The `user_tasks` projection rows a `StageInput`'s open-task booleans stand for — one row per OPEN
 * operator user task, keyed exactly as `pollUserTasks` records them, so the compiled `attention`
 * derivation sees the same engine-truth shape at runtime and here. */
function openTaskRows(run: StageInput): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  if (run.hasOpenBlockedTask === true) rows.push({ subject_type: "feature", subject_key: SELF_KEY, element_id: "feature-blocked" });
  if (run.hasOpenEscalationTask === true) rows.push({ subject_type: "feature", subject_key: SELF_KEY, element_id: "feature-escalation" });
  return rows;
}

/** Evaluate one derived column from the ONE `featureReadModel` declaration for a base row (plus any
 * projection rows the derivation correlates against). This is the single seam where the framework's
 * compiled-function boundary is crossed: `fnFor(column)` returns `unknown` (a derivation can compile to
 * any DSL value), while the caller statically knows the declared `lit(...)` shape of each column. */
function evalDerived<T>(column: FeatureReadModelDerivedColumn, baseRow: Record<string, unknown>, projections?: Record<string, Array<Record<string, unknown>>>): T {
  // biome-ignore lint/plugin: runtime/framework contract boundary — `fnFor` returns `unknown`; each derived column yields one of its declared DSL `lit(...)` values, whose type the caller knows.
  return featureReadModel.fnFor(column)(baseRow, projections) as T;
}

/** Derive the canonical pipeline stage, its render state, its not-in-path set, and its attention badge
 * for one feature run. Pure and read-only — TOTAL over all 11 statuses (never returns undefined). The
 * four columns are evaluated from the ONE `featureReadModel` declaration (app/featureReadModel.ts), so
 * this façade and the SQLite VIEW compute byte-identical values by construction. */
export function deriveStage(run: StageInput): DerivedStage {
  const baseRow = {
    feature_key: SELF_KEY,
    // The status-classifying derivations read the tracking VIEW's terminal-folded `derived_status`
    // (ADR-0065), so this façade feeds the caller's effective `status` under that column name — the SQL
    // VIEW reads `fr."derived_status"` off `feature_runs__tracking`, and both lowerings agree by
    // construction (`assertReadModelParity`). Callers off the write path pass the run's effective
    // status (which equals the base transient for any non-terminated run).
    [EFFECTIVE_STATUS_COLUMN]: run.status,
    pr_key: run.pr_key ?? null,
    converge: run.converge ?? null,
    auto_merge: run.auto_merge ?? null,
  };
  const projections = { [USER_TASKS_PROJECTION]: openTaskRows(run) };
  return {
    stage: evalDerived<StageKey>("stage", baseRow, projections),
    state: evalDerived<StageState>("stage_state", baseRow, projections),
    skipped: evalDerived<string>("stage_skipped", baseRow, projections),
    attention: evalDerived<string | null>("attention", baseRow, projections),
  };
}

/** The Active/History partition label (§5): `history` iff the row is in a truly-terminal status AND
 * acknowledged; otherwise `active` (live runs + terminal-but-UNACKNOWLEDGED runs). DERIVED on read from
 * the ONE `featureReadModel` `list_bucket` declaration — the same AST the VIEW compiles (migration 076),
 * NOT a write-time projection: the page's tabs filter the VIEW's derived `list_bucket`, and the stored
 * `feature_runs.list_bucket` base column is vestigial (retired as a write projection, issue #439). This
 * adapter is the TS lowering of that derivation, used off the write path (redispatch gating, tests). */
export function deriveListBucket(status: string, acknowledgedAt: string | null | undefined): "active" | "history" {
  return evalDerived<"active" | "history">("list_bucket", { [EFFECTIVE_STATUS_COLUMN]: status, acknowledged_at: acknowledgedAt ?? null });
}
