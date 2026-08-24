// The plan-family GROUP-BY rollups — DECLARED ONCE and compiled to BOTH backends via Urban's ADR-0065
// rollup primitive (`defineRollup`, `@nanobpm/urban`, capability nano-ide#468 / `@nanobpm/urban@0.82.0`).
//
// Background (issues #411 → #412 → #493). The Epic surfaces render DERIVED aggregate state — each epic's
// per-wave six-way task partition (059's `plan_wave_counts`), its wave FRONTIER (`wave_count`/
// `current_wave`, 060's `plan_wave_progress`), and its slice-PR landing counts (061's
// `plan_delivery_counts`). None of these are ground truth: each is a pure GROUP BY over `plan_tasks`
// joined to `pull_requests`. 059/060/061 expressed them as hand-authored SQL VIEWs *and* the runtime
// TS (`deriveDelivery` folded the same counts; the wave frontier was reproduced in the poller), kept in
// lockstep by hand-written parity tests — the ADR-0065 drift surface #2 (each aggregate authored twice).
//
// This module closes surface #2 for the aggregates STRUCTURALLY: each rollup is declared ONCE in Urban's
// closed GROUP-BY spec (`defineRollup`), and Urban compiles it to BOTH the managed `*_counts` VIEW
// (`viewDdl`/`sqlAggFor`, emitted verbatim into the superseding migration, drift-guarded) AND the
// runtime TS group-reduce (`reduce`, the sole engine behind the `deriveDelivery` façade in app/
// delivery.ts). The two lowerings fall out of the SAME closed spec, and `assertRollupParity` (app/
// planReadModel.test.ts) is the framework-owned regression guard that they agree.
//
// The per-row signals that CONSUME these counts (delivery / list_bucket / ack_open) live in
// app/planReadModel.ts (`defineReadModel` + key-correlated rollup lookups); the pre-formatted display
// strings (`bar`, `wave_label`, `delivery_label`) stay hand-authored over these derived columns (D3 —
// display formatting is out of the framework AST). Use app/featureReadModel.ts as the exemplar.

import { add, and, coalesce, col, count, countWhere, defineRollup, eq, fromRollup, gt, isNotNull, joinSource, lit, max, minWhere, not, or, type Rollup } from "@nanobpm/urban";

/** The PR statuses that are TERMINAL for delivery — a slice PR in any of these is resolved (not in
 * flight). The single source of truth is `TERMINAL_STATUSES` (app/delivery.ts); it is inlined as a
 * literal set here (rather than imported) to keep this module a leaf of the read-model dependency
 * graph — app/delivery.ts imports the read model, which imports this file. `plan_delivery_counts`'
 * `prs_in_flight` folds "NOT terminal (incl. a NULL/missing PR row)" exactly as `deriveDelivery` does. */
const DELIVERY_TERMINAL_PR_STATUSES = ["converged", "merged", "abandoned"] as const;

/** `plan_tasks t LEFT JOIN pull_requests p ON p.pr_key = t.pr_key` as a rollup source, with a FLAT
 * output namespace so the closed aggregate/predicate machinery reads unqualified column names. The two
 * plan-family count rollups both fold over this two-hop join (D4). */
const planTasksJoinPrs = joinSource({
  left: { relation: "plan_tasks", alias: "t" },
  right: { relation: "pull_requests", alias: "p" },
  on: [{ left: "pr_key", right: "pr_key" }],
  columns: {
    plan_key: ["left", "plan_key"],
    wave: ["left", "wave"],
    task_status: ["left", "status"],
    pr_key: ["left", "pr_key"],
    pr_status: ["right", "status"],
  },
});

/** `<pr_status> <> 'merged'` under the shared "NULL → not-merged" rule: `not(eq(...))` compiles to
 * `NOT COALESCE((pr_status = 'merged'), 0)` in SQL and the nullish-guarded negation in TS, so a task
 * whose PR row is absent (`pr_status` NULL) is treated as NOT merged in BOTH backends — matching 059's
 * `WHEN p.status = 'merged' THEN 0 …` fall-through (a NULL `p.status` never matches the merged arm). */
const prNotMerged = not(eq(col("pr_status"), lit("merged")));

/** `<task_status> = <value>` for a NON-merged task — the priority-ordered five-way bucket predicate the
 * 059 partition uses (`WHEN p.status = 'merged' THEN 0 WHEN t.status = '<b>' THEN 1 ELSE 0`), so the
 * five named buckets stay DISJOINT with `merged` and sum to `total`. */
const nonMergedTaskIs = (bucket: string) => and(prNotMerged, eq(col("task_status"), lit(bucket)));

/**
 * `plan_wave_counts` — one row per `(plan_key, wave)` with the six-way task partition (059). A task is
 * `merged` iff its PR reached `pull_requests.status = 'merged'`; otherwise it falls to its
 * `plan_tasks.status` bucket, and everything else (pending/opened/waiting-for-lane/abandoned) is
 * `in_flight`. The CASE priority (encoded as disjoint `countWhere` predicates) keeps the five named
 * buckets DISJOINT so they always sum to `total`. `WHERE wave IS NOT NULL` drops un-levelized tasks.
 */
export const planWaveCounts: Rollup = defineRollup({
  name: "plan_wave_counts",
  source: planTasksJoinPrs,
  groupBy: ["plan_key", "wave"],
  where: isNotNull(col("wave")),
  aggregates: {
    total: count(),
    merged: countWhere(eq(col("pr_status"), lit("merged"))),
    skipped: countWhere(nonMergedTaskIs("skipped")),
    blocked: countWhere(nonMergedTaskIs("blocked")),
    escalated: countWhere(nonMergedTaskIs("escalated")),
    in_flight: countWhere(and(prNotMerged, not(or(eq(col("task_status"), lit("skipped")), eq(col("task_status"), lit("blocked")), eq(col("task_status"), lit("escalated")))))),
  },
});

/**
 * `plan_wave_progress` — one row per `plan_key` with the two wave-frontier projections (060), COMPOSED
 * over `plan_wave_counts` (a rollup source — D1's composability):
 *   - `wave_count`   = `MAX(wave) + 1` (the levelizer emits contiguous waves 0..N-1).
 *   - `current_wave` = the live FRONTIER: the lowest wave that still has an `in_flight` task, else —
 *                      once every wave has settled — pinned to the last index `MAX(wave)`.
 * A plan with no levelized tasks contributes no `plan_wave_counts` row, so it is absent here and reads
 * NULL through the downstream read-model LEFT JOIN — matching the workers' taskless-plan behaviour.
 */
export const planWaveProgress: Rollup = defineRollup({
  name: "plan_wave_progress",
  source: fromRollup(planWaveCounts),
  groupBy: ["plan_key"],
  aggregates: {
    wave_count: add(max("wave"), 1),
    current_wave: coalesce(minWhere("wave", gt(col("in_flight"), lit(0))), max("wave")),
  },
});

/**
 * `plan_delivery_counts` — one row per `plan_key` with the three counts `deriveDelivery` folds over the
 * slice PRs (061). Only tasks that OPENED a PR count (`prs_opened = COUNT(pr_key)`, non-NULL). A
 * `pr_key` with no `pull_requests` row (`pr_status` NULL, the poller's `MISSING_PR_STATUS` sentinel) is
 * non-terminal, so it counts as `prs_in_flight` — a DB desync can never wrongly promote an epic to
 * `landed`. `prs_in_flight` = opened PRs whose status is NOT in {@link DELIVERY_TERMINAL_PR_STATUSES}
 * (a NULL status is not terminal), exactly `deriveDelivery`'s in-flight fold.
 */
export const planDeliveryCounts: Rollup = defineRollup({
  name: "plan_delivery_counts",
  source: planTasksJoinPrs,
  groupBy: ["plan_key"],
  aggregates: {
    prs_opened: count("pr_key"),
    prs_merged: countWhere(and(isNotNull(col("pr_key")), eq(col("pr_status"), lit("merged")))),
    prs_in_flight: countWhere(and(isNotNull(col("pr_key")), not(or(...DELIVERY_TERMINAL_PR_STATUSES.map((s) => eq(col("pr_status"), lit(s))))))),
  },
});

/** Every plan-family rollup, in managed-VIEW dependency order (a composed rollup after the rollup it
 * reads). The superseding migration emits their VIEW DDL in this order; the parity guard iterates it. */
export const PLAN_ROLLUPS: readonly Rollup[] = [planWaveCounts, planDeliveryCounts, planWaveProgress];
