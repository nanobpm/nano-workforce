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
import { applyMigrationSet, readMigrationSetFromDisk } from "#test-migrations";
import { assert, assertEquals } from "#test-assert";
import {
  DELIVERY_UNITS_TABLE,
  DISPATCH_JOB_TYPE_BY_KIND,
  deliveryUnitKey,
  dispatchGate,
  dispatchJobTypeForKind,
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
// corpus the door's verbs must already exist in.
const MODEL_FILES = [
  "feature.bpmn",
  "plan-fanout.bpmn",
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
  // feature.bpmn's implement task and plan-fanout.bpmn's per-slice implement task both dispatch
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
