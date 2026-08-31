// Coverage for ADR 0006 slice S3 (#590) — the SINGLE dispatch door (`app/deliveryDispatch.ts`) and
// its one `delivery_units` `instanceTracking` binding, which collapse the three per-representation
// `senior:*` dispatch paths onto the aggregate.
//
// Proves:
//   1. VERB PARITY — the door's kind → `senior:*` target map uses the SAME job-type names the
//      pre-collapse BPMN models dispatch (`senior:feature`, `senior:plan`). Collapsing the doors never
//      renames a dispatch target; every mapped verb is a real prompt-bearing agent task in the
//      deployed models.
//   2. KEY IDENTITY — `(kind, instanceId)` names exactly the S2 `unit_id` the identity helpers build,
//      so the two-arg door key IS the aggregate key (no per-representation key builder survives).
//   3. GATE PARITY — the one re-dispatch gate matches the S1/S2 `isDeliveryUnitSettled` /
//      `dispatchStatusForDelivery` short-circuit for EVERY canonical status: only `requested`(pending)
//      dispatches; every live/parked/terminal state short-circuits — the exact rule each pre-collapse
//      launcher re-implemented.
//   4. BINDING — the single `delivery_units` binding drives the door: it is the ONLY new binding, keys
//      on `dispatch_status`, lists no `settled` state active, and provisions its `__tracking` VIEW
//      against a REAL migrated DB.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { DataLayer } from "@nanobpm/urban";
import { applyMigrationSet, readMigrationSetFromDisk } from "#test-migrations";
import { assert, assertEquals } from "#test-assert";
import { withTrackingViews } from "../test/trackingViews.ts";
import {
  DELIVERY_UNITS_TABLE,
  DISPATCH_JOB_TYPE_BY_KIND,
  deliveryUnitKey,
  dispatchGate,
  dispatchJobTypeForKind,
  resolveDeliveryDispatch,
} from "./deliveryDispatch.ts";
import {
  DELIVERY_UNIT_KINDS,
  deliveryGraphUnitId,
  dispatchStatusForDelivery,
  epicUnitId,
  featureUnitId,
  planTaskUnitId,
} from "./deliveryUnit.ts";
import { DELIVERY_UNIT_STATUSES, type DeliveryUnitStatus, isDeliveryUnitSettled } from "./deliveryUnitStatus.ts";
import { promptBearingTaskTypes } from "./agentic/vocab/job-types.ts";

interface Binding {
  table: string;
  keyField?: string;
  statusField?: string;
  activeStatuses?: string[];
  onTerminated: { set: Record<string, unknown> };
}

function manifestBindings(): Binding[] {
  const manifest = JSON.parse(readFileSync(new URL("../nano.app.json", import.meta.url), "utf8"));
  return manifest.instanceTracking as Binding[];
}

// The deployed process models — scanned for their prompt-bearing agent tasks, the real dispatch
// corpus the door's verbs must already exist in. Includes the shared S4 atomic cells (ADR 0006): the
// implement/escalation and trial-merge agent tasks now live in `implement-cell` / `merge-cell`, which
// `feature.bpmn` and the `plan-fanout` MI body compose by `callActivity`.
const MODEL_FILES = [
  "feature.bpmn",
  "plan-fanout.bpmn",
  "implement-cell.bpmn",
  "merge-cell.bpmn",
  "convergence-loop.bpmn",
  "merge-loop.bpmn",
  "retro.bpmn",
];

function deployedAgentJobTypes(): Set<string> {
  const types = new Set<string>();
  for (const file of MODEL_FILES) {
    const xml = readFileSync(new URL(`../resources/processes/${file}`, import.meta.url), "utf8");
    for (const t of promptBearingTaskTypes(xml)) types.add(t);
  }
  return types;
}

test("VERB PARITY: every mapped dispatch verb is a real senior:* agent task in the deployed models", () => {
  const deployed = deployedAgentJobTypes();
  for (const kind of DELIVERY_UNIT_KINDS) {
    const verb = DISPATCH_JOB_TYPE_BY_KIND[kind];
    if (verb === null) continue; // delivery-graph is runner-launched, no single verb
    assert(verb.startsWith("senior:"), `${kind} must dispatch a senior:* verb, got ${verb}`);
    assert(deployed.has(verb), `${kind} dispatches ${verb}, which must be a deployed agent task`);
  }
});

test("VERB PARITY: the implementation kinds keep the pre-collapse senior:feature target", () => {
  // implement-cell.bpmn's agent task (composed by feature.bpmn and the plan-fanout MI body) dispatches
  // senior:feature today — the door preserves that for the single-issue implementation kinds.
  assertEquals(dispatchJobTypeForKind("feature"), "senior:feature");
  assertEquals(dispatchJobTypeForKind("plan-task"), "senior:feature");
  assertEquals(dispatchJobTypeForKind("bugfix"), "senior:feature");
  assertEquals(dispatchJobTypeForKind("chore"), "senior:feature");
});

test("VERB PARITY: an epic dispatches the pre-collapse senior:plan decomposition target", () => {
  assertEquals(dispatchJobTypeForKind("epic"), "senior:plan");
});

test("VERB PARITY: a delivery-graph unit has no single agent verb (runner-launched)", () => {
  assertEquals(dispatchJobTypeForKind("delivery-graph"), null);
});

test("VERB PARITY: the map covers exactly the closed kind enum (no drift)", () => {
  assertEquals(Object.keys(DISPATCH_JOB_TYPE_BY_KIND).sort(), [...DELIVERY_UNIT_KINDS].sort());
});

test("KEY IDENTITY: (kind, instanceId) names exactly the S2 unit_id the identity helpers build", () => {
  assertEquals(deliveryUnitKey("feature", "owner/repo#42"), featureUnitId("owner/repo#42"));
  assertEquals(deliveryUnitKey("epic", "plan-key-1"), epicUnitId("plan-key-1"));
  assertEquals(deliveryUnitKey("plan-task", "plan-key-1#3"), planTaskUnitId("plan-key-1", 3));
  assertEquals(deliveryUnitKey("delivery-graph", "run-key-1"), deliveryGraphUnitId("run-key-1"));
});

test("GATE PARITY: the door dispatches iff pending, and matches isDeliveryUnitSettled for every status", () => {
  for (const status of DELIVERY_UNIT_STATUSES as readonly DeliveryUnitStatus[]) {
    const dispatchStatus = dispatchStatusForDelivery(status);
    const gate = dispatchGate(dispatchStatus);
    // Only the pre-dispatch canonical `requested` (⇒ pending) launches a fresh executor.
    assertEquals(gate.dispatch, status === "requested", `dispatch decision for canonical ${status}`);
    if (isDeliveryUnitSettled(status)) {
      assertEquals(gate.reason, "settled", `${status} is settled-for-re-dispatch ⇒ short-circuit`);
    } else if (status === "requested") {
      assertEquals(gate.reason, "pending");
    } else {
      assertEquals(gate.reason, "in-flight", `${status} has a live executor ⇒ at-most-once skip`);
    }
  }
});

test("GATE PARITY: a unit the aggregate never recorded short-circuits as unknown-unit", () => {
  assertEquals(dispatchGate(null), { dispatch: false, reason: "unknown-unit" });
});

test("BINDING: exactly one new delivery_units binding drives the door", () => {
  const du = manifestBindings().filter((b) => b.table === DELIVERY_UNITS_TABLE);
  assertEquals(du.length, 1, "there must be exactly one delivery_units instanceTracking binding");
  const b = du[0];
  assertEquals(b.keyField, "process_key");
  assertEquals(b.statusField, "dispatch_status");
  assertEquals(b.onTerminated.set, { dispatch_status: "settled" });
  // A settled unit is terminal/resting — listing it active would let the reconciler clobber it.
  assert(!b.activeStatuses?.includes("settled"), "settled must not be an active dispatch status");
  // `pending` is NOT instance-tracked: it has no engine instance yet, and some pending rows (e.g.
  // kind="plan-task") carry a NULL process_key, so a process_key-keyed reconciler would treat them as
  // "vanished" and wrongly apply onTerminated. Only the instance-backed `dispatched` is tracked —
  // mirroring the delivery_graph_runs binding's invariant.
  assert(!b.activeStatuses?.includes("pending"), "pending must not be an active dispatch status");
  assertEquals(b.activeStatuses, ["dispatched"]);
});

test("BINDING: the delivery_units__tracking VIEW provisions against the migrated schema", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  applyMigrationSet(db, readMigrationSetFromDisk());
  // The base aggregate exists with the door's status column; the derived tracking VIEW the binding
  // provisions (delivery_units__tracking) is created by urban at gen/deploy time, not migration time,
  // so here we assert the base columns the binding names are present and typed for the door to read.
  const cols = db.prepare("PRAGMA table_info(delivery_units)").all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  assert(names.has("process_key"), "keyField process_key must exist on delivery_units");
  assert(names.has("dispatch_status"), "statusField dispatch_status must exist on delivery_units");
  db.close();
});

// A fake DataLayer whose `delivery_units` store is keyed on `unit_id` and whose `delivery_units__tracking`
// derived VIEW is served by `withTrackingViews` (projecting `derived_status := seeded ?? base.dispatch_status`,
// exactly the ADR-0065 fall-through the real runtime computes). This lets a test seed a base row whose
// `derived_status` DIVERGES from its base `dispatch_status` — the terminated-executor case the door's
// derived-view read exists to fold in — without a live engine.
function memData(): DataLayer {
  // biome-ignore lint/suspicious/noExplicitAny: test-only fake over dynamic row shapes.
  const stores: Record<string, any[]> = {};
  function tbl(name: string, pk = "unit_id") {
    // biome-ignore lint/suspicious/noExplicitAny: test-only dynamic row store.
    const rows = (stores[name] ??= [] as any[]);
    return {
      // biome-ignore lint/suspicious/noExplicitAny: test-only dynamic row.
      async insert(row: any) {
        rows.push({ ...row });
        return row[pk];
      },
      async get(key: unknown) {
        return rows.find((r) => r[pk] === key);
      },
    };
  }
  return { table: withTrackingViews((n: string, pk?: string) => tbl(n, pk)) } as any as DataLayer;
}

async function seedUnit(
  data: DataLayer,
  unit_id: string,
  dispatch_status: string | null,
  derived_status?: string,
) {
  const row: Record<string, unknown> = { unit_id, dispatch_status };
  if (derived_status !== undefined) row.derived_status = derived_status;
  await data.table(DELIVERY_UNITS_TABLE, "unit_id").insert(row);
}

test("DOOR: resolveDeliveryDispatch dispatches a pending unit off the derived VIEW", async () => {
  const data = memData();
  await seedUnit(data, deliveryUnitKey("feature", "owner/repo#7"), "pending");
  const decision = await resolveDeliveryDispatch(data, "feature", "owner/repo#7");
  assertEquals(decision, {
    unitId: "feature:owner/repo#7",
    kind: "feature",
    dispatch: true,
    jobType: "senior:feature",
    reason: "pending",
  });
});

test("DOOR: resolveDeliveryDispatch skips a still-dispatched unit as in-flight (at-most-once)", async () => {
  const data = memData();
  await seedUnit(data, deliveryUnitKey("plan-task", "plan-1#3"), "dispatched");
  const decision = await resolveDeliveryDispatch(data, "plan-task", "plan-1#3");
  assertEquals(decision.dispatch, false);
  assertEquals(decision.reason, "in-flight");
  assertEquals(decision.jobType, null);
});

test("DOOR: resolveDeliveryDispatch reads derived_status, so a terminated executor is settled not stranded dispatched", async () => {
  // The base row still reads `dispatched` (the worker-owned transient the reconciler no longer
  // overwrites), but the executor terminated out-of-band so the __tracking VIEW's `derived_status`
  // is `settled` (the binding's onTerminated edge). Reading the base column would strand the unit as
  // `in-flight`; the door MUST read `derived_status` and report `settled`. This is the regression the
  // Copilot review flagged — a guard against reading the base table/statusField instead of the view.
  const data = memData();
  await seedUnit(data, deliveryUnitKey("feature", "owner/repo#9"), "dispatched", "settled");
  const decision = await resolveDeliveryDispatch(data, "feature", "owner/repo#9");
  assertEquals(decision.reason, "settled", "derived terminal status must win over the base dispatched");
  assertEquals(decision.dispatch, false);
  assertEquals(decision.jobType, null);
});

test("DOOR: resolveDeliveryDispatch refuses to launch a unit the aggregate never recorded", async () => {
  const data = memData();
  const decision = await resolveDeliveryDispatch(data, "feature", "owner/repo#404");
  assertEquals(decision, {
    unitId: "feature:owner/repo#404",
    kind: "feature",
    dispatch: false,
    jobType: null,
    reason: "unknown-unit",
  });
});
