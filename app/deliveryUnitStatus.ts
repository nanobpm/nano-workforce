// The ONE delivery-unit status union — ADR 0006 slice **S1** (status lifecycle).
//
// Background (ADR 0006, issue #464). nano-workforce models the same aggregate — a *scheduled unit of
// work driven to a delivery outcome* — in three separate representations, each with its OWN bespoke
// status union:
//
//   * feature   — `FEATURE_RUN_STATUSES` (11: running/escalated/opened/converging/awaiting_operator/
//                 merged/converged/blocked/skipped/failed/abandoned) — app/feature.ts
//   * epic      — the `plans` aggregate (`planning`/`dispatched`/`done`/`failed`/`abandoned`, the union
//                 of `EPIC_LIVE_STATUSES` + `PLAN_TERMINAL_STATUSES`, app/delivery.ts + app/plan.ts)
//                 AND its `plan_tasks` NODE status `PLAN_TASK_STATUSES` (7) — app/plan.ts
//   * graph     — `DELIVERY_GRAPH_RUN_STATUSES` (5: awaiting-approval/running/done/failed/abandoned)
//                 — app/deliveryGraphRun.ts
//
// A change to "what states a unit of work can be in" therefore has to be made, by hand, in three (four,
// counting the epic's two levels) places that can silently drift — exactly the "No drift surfaces /
// derivation over duplication" hazard this repo treats as a defect class (AGENTS.md).
//
// This module is S1's deliverable: it defines the SINGLE canonical aggregate union
// ({@link DELIVERY_UNIT_STATUSES}) and, via ADR-0065's `defineReadModel`, the per-shape derivations that
// map each bespoke union INTO it — declared ONCE and compiled to BOTH the SQLite VIEW select-list
// (`sqlSelectFor`, for S2's `delivery_units`-backed VIEWs) AND the runtime TS oracle (`fnFor`, for the
// reconcilers). There is nothing to keep in lockstep: the two lowerings fall out of the same closed-DSL
// AST, and `assertReadModelParity` (app/deliveryUnitStatus.test.ts) proves they agree.
//
// SCOPE (S1). This slice OWNS the canonical vocabulary, the per-shape mapping, the terminal/settled
// precedence, and the node-vs-aggregate decision (below). It does NOT repoint any existing VIEW or move
// any writer/`instanceTracking` binding onto the new union — the legacy tables stay the physical write
// target through S2, and the `instanceTracking` bindings + `senior:*` doors collapse in S3 (ADR 0006
// rollout). The derivations here are the single source those later slices reference, not a second
// projection alongside them.

import { caseWhen, col, defineReadModel, type Expr, eq, lit, type ReadModel, when } from "@nanobpm/urban";
import { EPIC_LIVE_STATUSES } from "./delivery.ts";
import type { DeliveryGraphRunStatus } from "./deliveryGraphRun.ts";
import type { FeatureRunStatus } from "./feature.ts";
import { PLAN_TERMINAL_STATUSES, type PlanTaskStatus } from "./plan.ts";

/**
 * The ONE canonical delivery-unit status union — the single source of truth for "what state a unit of
 * work is in", replacing the three bespoke unions. A superset that preserves every source union's
 * distinctions without loss (feature is the reference shape, so its members pass through by name):
 *
 *  - `requested`         — created, not yet dispatched to an executor (no live engine instance yet).
 *  - `running`           — an executor (agent/probe/connector) is actively working the unit.
 *  - `escalated`         — NON-terminal: parked awaiting a HUMAN answer (an open escalation user task).
 *  - `awaiting_operator` — NON-terminal: parked awaiting an OPERATOR acknowledgement (blocked wait).
 *  - `waiting`           — NON-terminal: parked on a lane / dependency gate (a wave barrier).
 *  - `opened`            — a PR was raised and the unit rests here (convergence was not requested).
 *  - `converging`        — the opened PR is in its review-convergence loop.
 *  - `converged`         — TERMINAL: review converged but the PR did not merge (auto-merge off).
 *  - `merged`            — TERMINAL: the PR landed (the win).
 *  - `done`              — TERMINAL: an aggregate settled successfully WITHOUT a single-PR terminal
 *                          (an epic/graph whose members all landed) — the PR-less success outcome.
 *  - `skipped`           — TERMINAL: nothing to do.
 *  - `blocked`           — TERMINAL: could not proceed / gave up (distinct from the non-terminal
 *                          `awaiting_operator` wait — a `blocked` unit is settled, not parked).
 *  - `failed`            — TERMINAL: an unexpected failure.
 *  - `abandoned`         — TERMINAL: the PR was abandoned, or the process instance was cancelled.
 */
export const DELIVERY_UNIT_STATUSES = [
  "requested",
  "running",
  "escalated",
  "awaiting_operator",
  "waiting",
  "opened",
  "converging",
  "converged",
  "merged",
  "done",
  "skipped",
  "blocked",
  "failed",
  "abandoned",
] as const;
export type DeliveryUnitStatus = (typeof DELIVERY_UNIT_STATUSES)[number];

/**
 * The TRULY-terminal ("done tier") statuses — a unit in one of these has settled to a final outcome and
 * will not advance again. Mirrors the union of the source terminal sets (`FEATURE_TERMINAL_STATUSES`
 * minus its live PR stages, `PLAN_TERMINAL_STATUSES`, `DELIVERY_GRAPH_TERMINAL_STATUSES`). Distinct from
 * {@link DELIVERY_UNIT_SETTLED_STATUSES}: `opened`/`converging` are settled FOR RE-DISPATCH but are LIVE
 * pipeline stages, not `done`.
 */
export const DELIVERY_UNIT_TERMINAL_STATUSES: readonly DeliveryUnitStatus[] = [
  "converged",
  "merged",
  "done",
  "skipped",
  "blocked",
  "failed",
  "abandoned",
];

/**
 * The SETTLED-FOR-RE-DISPATCH statuses — {@link DELIVERY_UNIT_TERMINAL_STATUSES} plus the two live PR
 * resting stages (`opened`/`converging`) a unit stops at without a further wave restart. Mirrors
 * `FEATURE_TERMINAL_STATUSES` (app/feature.ts), which likewise counts `opened`/`converging` as terminal
 * for re-dispatch gating even though they are LIVE (not `done`). A re-dispatch of the same unit
 * short-circuits IFF its prior run is in one of these; the NON-terminal parked waits
 * (`escalated`/`awaiting_operator`/`waiting`) and `running`/`requested` are excluded, so a live or
 * parked unit is never orphaned by a parallel restart.
 */
export const DELIVERY_UNIT_SETTLED_STATUSES: readonly DeliveryUnitStatus[] = [
  ...DELIVERY_UNIT_TERMINAL_STATUSES,
  "opened",
  "converging",
];

/** True iff `status` is a truly-terminal ("done tier") delivery-unit status. */
export const isDeliveryUnitTerminal = (status: DeliveryUnitStatus): boolean =>
  DELIVERY_UNIT_TERMINAL_STATUSES.includes(status);

/** True iff `status` is settled for RE-DISPATCH (terminal, or a live PR resting stage). */
export const isDeliveryUnitSettled = (status: DeliveryUnitStatus): boolean =>
  DELIVERY_UNIT_SETTLED_STATUSES.includes(status);

/**
 * The plan AGGREGATE lifecycle values — the union of the two existing sources (`EPIC_LIVE_STATUSES` +
 * `PLAN_TERMINAL_STATUSES`), NOT re-listed here, so this stays a derived view of them and cannot drift.
 */
export const PLAN_STATUSES = [...EPIC_LIVE_STATUSES, ...PLAN_TERMINAL_STATUSES] as const;

// ── Per-shape mappings — declared ONCE, keyed by the SOURCE union so `tsc` fails if a source union
//    gains a member without a canonical mapping (the type-level No-Drift guard). ──────────────────────

/**
 * Feature is the REFERENCE shape: every `FEATURE_RUN_STATUSES` member has a same-named canonical member,
 * so the map is the identity. The distinct feature waits survive intact — `escalated` (human),
 * `awaiting_operator` (operator), and the terminal `blocked` (gave up) stay three different states.
 */
export const FEATURE_STATUS_TO_UNIT: Record<FeatureRunStatus, DeliveryUnitStatus> = {
  running: "running",
  escalated: "escalated",
  opened: "opened",
  converging: "converging",
  awaiting_operator: "awaiting_operator",
  merged: "merged",
  converged: "converged",
  blocked: "blocked",
  skipped: "skipped",
  failed: "failed",
  abandoned: "abandoned",
};

/**
 * Plan AGGREGATE → canonical. `planning` (decomposing, no fan-out yet) is pre-dispatch ⇒ `requested`;
 * `dispatched` (fan-out running) ⇒ `running`; the three terminals pass through. Keyed by the plan
 * aggregate value (a bare string in `Plan.status`), covering every {@link PLAN_STATUSES} member.
 */
export const PLAN_STATUS_TO_UNIT: Record<(typeof PLAN_STATUSES)[number], DeliveryUnitStatus> = {
  planning: "requested",
  dispatched: "running",
  done: "done",
  failed: "failed",
  abandoned: "abandoned",
};

/**
 * Plan-task NODE → canonical. **Node-vs-aggregate decision (ADR 0006 §4):** a node is a DEGENERATE
 * delivery unit, so its status maps into the SAME canonical union rather than carrying a separate node
 * contract — there is ONE vocabulary. The node-specific lane/dependency wait (`waiting-for-lane`) is
 * expressed by the canonical `waiting` member (a state the aggregate level never enters); `pending`
 * (queued, not yet run in its wave) is pre-dispatch ⇒ `requested`.
 */
export const PLAN_TASK_STATUS_TO_UNIT: Record<PlanTaskStatus, DeliveryUnitStatus> = {
  pending: "requested",
  opened: "opened",
  blocked: "blocked",
  skipped: "skipped",
  escalated: "escalated",
  "waiting-for-lane": "waiting",
  abandoned: "abandoned",
};

/**
 * Delivery-graph RUN → canonical. `awaiting-approval` (reserved, pre-dispatch: no live instance, parked
 * before launch — issue #460) ⇒ `requested`; `running` passes through; the three terminals pass through.
 */
export const DELIVERY_GRAPH_STATUS_TO_UNIT: Record<DeliveryGraphRunStatus, DeliveryUnitStatus> = {
  "awaiting-approval": "requested",
  running: "running",
  done: "done",
  failed: "failed",
  abandoned: "abandoned",
};

/**
 * Build the canonical `delivery_status` derivation for one shape as a closed-DSL {@link Expr}: a
 * `CASE` over the base row's `status` column, one `WHEN status = '<source>' THEN '<canonical>'` per map
 * entry. The map is TOTAL over its source union, so the `ELSE` is unreachable in practice; it falls back
 * to `null` (never an invented status) so an out-of-band source value surfaces as NULL rather than a
 * silent mis-map. Both backends (`sqlSelectFor` VIEW body, `fnFor` runtime) fall out of this one AST.
 */
export const deliveryStatusExpr = (map: Readonly<Record<string, DeliveryUnitStatus>>): Expr =>
  caseWhen(
    Object.entries(map).map(([source, unit]) => when(eq(col("status"), lit(source)), lit(unit))),
    lit(null),
  );

/** The single derived column every per-shape delivery-unit read model exposes. */
export const DELIVERY_STATUS_COLUMN = "delivery_status";

/** The base alias the managed VIEWs give each source table — pinned so emitted SQL is stable/testable. */
export const DELIVERY_UNIT_STATUS_BASE_ALIAS = "du";

const statusReadModel = (name: string, baseTable: string, map: Readonly<Record<string, DeliveryUnitStatus>>): ReadModel =>
  defineReadModel({
    name,
    baseTable,
    selectBaseColumns: false,
    derive: { [DELIVERY_STATUS_COLUMN]: deliveryStatusExpr(map) },
  });

/**
 * The four per-shape derivations of the ONE canonical union, each a `defineReadModel` exposing a single
 * `delivery_status` column over its source table. S2 provisions these as VIEWs over `delivery_units`;
 * the reconcilers consume `fnFor(DELIVERY_STATUS_COLUMN)`. They all target {@link DELIVERY_UNIT_STATUSES}
 * — the union is single-sourced; only the per-shape MAPPING differs.
 */
export const featureDeliveryStatus: ReadModel = statusReadModel("feature_delivery_status", "feature_runs", FEATURE_STATUS_TO_UNIT);
export const planDeliveryStatus: ReadModel = statusReadModel("plan_delivery_status", "plans", PLAN_STATUS_TO_UNIT);
export const planTaskDeliveryStatus: ReadModel = statusReadModel("plan_task_delivery_status", "plan_tasks", PLAN_TASK_STATUS_TO_UNIT);
export const deliveryGraphDeliveryStatus: ReadModel = statusReadModel("delivery_graph_delivery_status", "delivery_graph_runs", DELIVERY_GRAPH_STATUS_TO_UNIT);

/** All four per-shape delivery-status read models, for bulk registration/validation by later slices. */
export const DELIVERY_STATUS_READ_MODELS: readonly ReadModel[] = [
  featureDeliveryStatus,
  planDeliveryStatus,
  planTaskDeliveryStatus,
  deliveryGraphDeliveryStatus,
];

/**
 * Map a source status to the canonical union in-process (the TS backend of {@link deliveryStatusExpr},
 * via the compiled `fnFor`) — the reconciler-facing helper. Returns `null` for an unmapped value,
 * matching the VIEW's `ELSE NULL`.
 */
export const toDeliveryUnitStatus = (model: ReadModel, status: string | null): DeliveryUnitStatus | null =>
  // biome-ignore lint/plugin: runtime/framework contract boundary — `fnFor` returns `unknown`; the derived column yields one of its declared `lit(...)` canonical statuses (or null on the ELSE arm).
  model.fnFor(DELIVERY_STATUS_COLUMN)({ status }) as DeliveryUnitStatus | null;
