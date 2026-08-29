// ADR 0006 slice S2 (#589) — the `delivery_units` aggregate, TS side.
//
// S2 collapses the four legacy delivery-unit representations (`feature_runs`, `plans`, `plan_tasks`,
// `delivery_graph_runs`) onto ONE kind-tagged aggregate table (`db/migrations/088_delivery_units.sql`).
// The data-level sync is done at the DB layer — triggers mirror every legacy write into the aggregate
// (089), a backfill seeds pre-existing rows (090), and legacy-shaped compat VIEWs are served FROM the
// aggregate (091) — so this module carries NO write path of its own; it is the canonical TS home for
// the aggregate's VOCABULARY (the closed `kind` enum, the `dispatch_status` lifecycle), the universal
// `unit_id` derivation, and the `dispatch_status` derivation. The last two are also lowered to SQL in
// the trigger/backfill migrations; app/deliveryUnit.test.ts proves the two lowerings agree over the
// full status/shape matrix (the same declare-once / parity-guard discipline S1 uses for the status
// union — derivation over duplication).
//
// SCOPE (S2). This owns the aggregate's identity + dispatch vocabulary and a read gateway. The single
// dispatch door (S3) will key on `dispatch_status`; repointing live writers onto `delivery_units` and
// retiring the legacy write paths is the later CONTRACT phase (S3), sequenced after the
// `instanceTracking` doors move. Nothing here changes existing behaviour.

import type { DataLayer, Table } from "@nanobpm/urban";
import { type DeliveryUnitStatus, isDeliveryUnitSettled } from "./deliveryUnitStatus.ts";

/**
 * The closed §2 `kind` enum covering every delivery unit. A run of an epic is ONE unit (`kind='epic'`,
 * a composition over its slices); each slice is a `plan-task` node under it. `feature` is the
 * degenerate 1-node unit; `delivery-graph` is the arbitrary-DAG unit. `bugfix`/`chore` are reserved
 * §2 members with no legacy table yet. Kept in lockstep with the `CHECK (kind IN (…))` constraint in
 * migration 088 — a parity test pins the two.
 */
export const DELIVERY_UNIT_KINDS = ["feature", "epic", "plan-task", "delivery-graph", "bugfix", "chore"] as const;
export type DeliveryUnitKind = (typeof DELIVERY_UNIT_KINDS)[number];

/**
 * The `dispatch_status` lifecycle — the single dispatch door's status (ADR 0006 §4; the S3 door
 * collapses onto it). Derived from the canonical {@link DeliveryUnitStatus}:
 *  - `pending`    — created, not yet dispatched to an executor (canonical `requested`).
 *  - `dispatched` — a live executor/instance is working the unit (a live/parked non-terminal status).
 *  - `settled`    — terminal, or a live PR resting stage (`opened`/`converging`): re-dispatchable. This
 *                   is exactly the {@link isDeliveryUnitSettled} predicate, so the dispatch door's
 *                   short-circuit gate matches the redispatch-settled semantics S1 defined.
 */
export const DISPATCH_STATUSES = ["pending", "dispatched", "settled"] as const;
export type DeliveryUnitDispatchStatus = (typeof DISPATCH_STATUSES)[number];

/**
 * Derive the `dispatch_status` from a canonical delivery-unit status — the TS lowering of the CASE the
 * sync-trigger/backfill migrations (089/090) apply in SQL. `requested` ⇒ `pending`; a settled status
 * (terminal or a PR resting stage) ⇒ `settled`; every other (live/parked) status ⇒ `dispatched`.
 */
export function dispatchStatusForDelivery(status: DeliveryUnitStatus): DeliveryUnitDispatchStatus {
  if (status === "requested") return "pending";
  if (isDeliveryUnitSettled(status)) return "settled";
  return "dispatched";
}

// ── Universal `unit_id` — the cross-representation fact every agent can name and the dispatch door
//    keys on (#464 "What survives" #4). Kept in lockstep with the `unit_id` expressions the
//    trigger/backfill migrations build; app/deliveryUnit.test.ts pins the two. ─────────────────────

/** The `feature:<feature_key>` unit id for a single-issue feature run. */
export const featureUnitId = (featureKey: string): string => `feature:${featureKey}`;

/** The `epic:<plan_key>` unit id for an epic (the `plans` aggregate row). */
export const epicUnitId = (planKey: string): string => `epic:${planKey}`;

/**
 * The `plan-task:<plan_key>#<task_index>` unit id for one epic slice NODE. Its composition parent is
 * {@link epicUnitId}(planKey) — the epic unit it hangs under.
 */
export const planTaskUnitId = (planKey: string, taskIndex: number): string => `plan-task:${planKey}#${taskIndex}`;

/** The `delivery-graph:<run_key>` unit id for a delivery-graph run. */
export const deliveryGraphUnitId = (runKey: string): string => `delivery-graph:${runKey}`;

/**
 * One row of the `delivery_units` aggregate. `unit_id`/`kind` are the identity pair; `delivery_status`
 * is the canonical S1 union value; `status` is the raw legacy source status (kept verbatim so the
 * compat VIEWs reconstruct legacy rows losslessly); `dispatch_status` is the door lifecycle. The
 * per-shape legacy columns ride the same row (nullable off-kind). Read-only for S2 — the physical
 * write target stays the legacy tables (the triggers mirror in).
 */
export interface DeliveryUnitRow {
  unit_id: string;
  kind: DeliveryUnitKind;
  legacy_key: string | null;
  legacy_id: number | null;
  parent_unit_id: string | null;
  node_index: number | null;
  delivery_status: DeliveryUnitStatus | null;
  dispatch_status: DeliveryUnitDispatchStatus | null;
  status: string | null;
  repo: string | null;
  issue_number: number | null;
  issue_url: string | null;
  title: string | null;
  base_branch: string | null;
  process_key: string | null;
  pr_key: string | null;
  outcome: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * The read gateway over the `delivery_units` aggregate, keyed on the universal `unit_id`. Read-only in
 * S2 (writes flow through the legacy tables + the sync triggers); the S3 dispatch door will own the
 * write path once the legacy writers retire.
 */
export const deliveryUnits = (data: DataLayer): Table<DeliveryUnitRow> =>
  data.table<DeliveryUnitRow>("delivery_units", "unit_id");
