// ADR 0006 slice S3 (#590) — the SINGLE dispatch door, keyed on `(kind, instanceId)`.
//
// Before S3 the fleet had THREE parallel dispatch paths — one per delivery-unit REPRESENTATION
// (`feature` via feature.bpmn, `epic`/`plan-task` via plan-fanout.bpmn, `delivery-graph` via the
// engine-native runner) — each choosing its own `senior:*` implementation job and each gating
// re-dispatch off its own bespoke status union. ADR 0006 §2 collapses those onto ONE door that reads
// the aggregate's `delivery_units.dispatch_status` and dispatches on the two universal facts a unit
// carries — its `kind` and its `instanceId` — instead of three representation-specific launchers.
//
// What this door owns:
//   1. The `(kind, instanceId) → unit_id` key derivation (the aggregate's universal identity; the
//      unit_id IS `<kind>:<instanceId>`, so the door's two args ARE the delivery unit's key).
//   2. The kind → STABLE `senior:*` dispatch-target verb map. Per #464 ("What survives" #3) the
//      `senior:*` names are DISPATCH TARGETS, not implementations — they stay the stable verbs the
//      deployed fleet already answers (`senior:feature`, `senior:plan`), so collapsing the doors never
//      renames a job type.
//   3. The single re-dispatch gate, read straight off `dispatch_status` (the S2 lifecycle derived from
//      the S1 canonical union): dispatch ONLY when `pending`; a `dispatched` unit has a live executor
//      (at-most-once) and a `settled` unit already reached a terminal/resting outcome — both
//      short-circuit. This is exactly the `isDeliveryUnitSettled` re-dispatch semantics S1/S2 defined,
//      so the one door matches every pre-collapse launcher's short-circuit without re-deriving it.
//
// The active/tracking half is wired in `nano.app.json`: a single `delivery_units` `instanceTracking`
// binding (keyField `process_key`, statusField `dispatch_status`) replaces the per-representation
// bindings as the SOURCE the door is driven by — `deliveryUnitActiveDispatchStatuses()` reads that one
// binding, so the door and the framework reconciler can never drift on "what counts as in-flight".

import type { DataLayer } from "@nanobpm/urban";
import { type DeliveryUnitDispatchStatus, type DeliveryUnitKind, deliveryUnits } from "./deliveryUnit.ts";
import { activeStatusesFor } from "./instanceTracking.ts";

/** The base table the single dispatch door is keyed on — the S2 aggregate. */
export const DELIVERY_UNITS_TABLE = "delivery_units";

/**
 * The stable `senior:*` dispatch-target verb each delivery-unit KIND dispatches to — the collapse of
 * the per-representation launchers onto one map (#464 "What survives" #3). The verbs are unchanged
 * from the pre-collapse models (`app/deliveryDispatch.test.ts` pins them against the deployed BPMN):
 *  - `feature` / `plan-task` — a single-issue implementation ⇒ `senior:feature` (feature.bpmn's
 *    implement task and plan-fanout.bpmn's per-slice implement task both dispatch this today).
 *  - `epic` — decomposed into a wave of slices by the planner ⇒ `senior:plan` (plan-fanout.bpmn's
 *    decomposition task).
 *  - `bugfix` / `chore` — reserved §2 implementation units with no legacy table yet; they implement an
 *    issue like a feature ⇒ `senior:feature`.
 *  - `delivery-graph` — dispatched by the engine-native runner (`app/deliveryRunner.ts`), NOT a single
 *    agent verb: every node in the graph carries its OWN `jobType`, so the unit has no single dispatch
 *    target. `null` records that the runner, not this verb map, launches a delivery-graph unit.
 */
export const DISPATCH_JOB_TYPE_BY_KIND: Readonly<Record<DeliveryUnitKind, string | null>> = {
  feature: "senior:feature",
  "plan-task": "senior:feature",
  epic: "senior:plan",
  bugfix: "senior:feature",
  chore: "senior:feature",
  "delivery-graph": null,
};

/** The dispatch-target verb for a kind, or `null` for a runner-launched (`delivery-graph`) unit. */
export function dispatchJobTypeForKind(kind: DeliveryUnitKind): string | null {
  return DISPATCH_JOB_TYPE_BY_KIND[kind];
}

/**
 * The universal `unit_id` a `(kind, instanceId)` pair names — `<kind>:<instanceId>`. The S2 identity
 * helpers (`featureUnitId` = `feature:<key>`, `epicUnitId` = `epic:<key>`, `planTaskUnitId` =
 * `plan-task:<key>#<idx>`, `deliveryGraphUnitId` = `delivery-graph:<runKey>`) are all exactly this
 * shape, so the door's two args ARE the aggregate key — no per-representation key builder survives.
 */
export function deliveryUnitKey(kind: DeliveryUnitKind, instanceId: string): string {
  return `${kind}:${instanceId}`;
}

/** The non-`settled` dispatch statuses the single `delivery_units` binding declares in-flight, read
 * from nano.app.json (the one source of truth). The door never hard-codes this set — it derives from
 * the same binding the framework reconciler polls, so "in-flight" can't drift between the two. */
export function deliveryUnitActiveDispatchStatuses(): readonly string[] {
  return activeStatusesFor(DELIVERY_UNITS_TABLE);
}

/** Why the single door did or did not dispatch — a closed reason set the caller can log/route on. */
export type DispatchReason = "pending" | "in-flight" | "settled" | "unknown-unit";

/** The single dispatch door's decision for one `(kind, instanceId)`. `dispatch` is the gate; `jobType`
 * is the stable `senior:*` target when a fresh dispatch is due (and the kind has an agent verb). */
export interface DispatchDecision {
  unitId: string;
  kind: DeliveryUnitKind;
  dispatch: boolean;
  jobType: string | null;
  reason: DispatchReason;
}

/**
 * The single re-dispatch gate, applied to a `dispatch_status`. This is the ONE short-circuit rule the
 * three pre-collapse launchers each re-implemented against their own union:
 *  - `pending`    ⇒ dispatch (created, no executor yet — the canonical `requested`).
 *  - `dispatched` ⇒ skip, a live executor already holds the unit (at-most-once).
 *  - `settled`    ⇒ skip, the prior run reached a terminal / live-PR resting outcome
 *                   (`isDeliveryUnitSettled`) — re-dispatch short-circuits onto it.
 *  - missing row  ⇒ skip (`unknown-unit`): the door refuses to launch a unit the aggregate never saw
 *                   rather than dispatch blind.
 */
export function dispatchGate(status: DeliveryUnitDispatchStatus | null): { dispatch: boolean; reason: DispatchReason } {
  if (status === null) return { dispatch: false, reason: "unknown-unit" };
  if (status === "pending") return { dispatch: true, reason: "pending" };
  if (status === "dispatched") return { dispatch: false, reason: "in-flight" };
  return { dispatch: false, reason: "settled" };
}

/**
 * Resolve the single dispatch door for a `(kind, instanceId)`: read the unit's `dispatch_status` off
 * the `delivery_units` aggregate and apply {@link dispatchGate}, returning the stable `senior:*`
 * target verb when a fresh dispatch is due. A row the aggregate never recorded resolves to
 * `unknown-unit` (no dispatch) — the door never launches blind.
 */
export async function resolveDeliveryDispatch(
  data: DataLayer,
  kind: DeliveryUnitKind,
  instanceId: string,
): Promise<DispatchDecision> {
  const unitId = deliveryUnitKey(kind, instanceId);
  const unit = await deliveryUnits(data).get(unitId);
  const { dispatch, reason } = dispatchGate(unit?.dispatch_status ?? null);
  return {
    unitId,
    kind,
    dispatch,
    jobType: dispatch ? dispatchJobTypeForKind(kind) : null,
    reason,
  };
}
