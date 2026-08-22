// Unit coverage for the delivery-graph run aggregate (ADR 0005 Decision 7) — the pure decision helpers
// (the idempotency key, the parked human-label map, the derived parked-node phase), plus the durable
// at-most-once launch-claim fence (`claimRunForLaunch`) exercised against the real provisioned SQLite
// data layer so its actual `status <> 'running'` compare-and-swap SQL is validated, not just modelled.
// The COMPOSED dispatch behaviour at the edge is proven by operations/dispatchDeliveryGraph.test.ts
// and app/deliveryGraphDispatch.test.ts (the operator dispatch action).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import { bootTestApp } from "@nanobpm/urban-testkit";
import { compileDeliveryGraph } from "./deliveryGraphCompiler.ts";
import {
  buildDeliveryGraphRunRow,
  buildHumanLabels,
  claimRunForLaunch,
  computeRunKey,
  deriveDeliveryPhase,
  DELIVERY_PHASE,
  deliveryGraphRuns,
  humanTaskElementId,
  parseHumanLabels,
} from "./deliveryGraphRun.ts";
import { pollDeliveryGraphPhase } from "./service.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");

/** Boot an app purely for its provisioned data layer (migration 058 applied), run `fn`, tear down. */
async function withData(fn: (data: DataLayer) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-dgrun-"));
  const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dir, "app.db")}` } });
  try {
    await fn(app.db);
  } finally {
    await app.stop?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

const claimRow = (status: "awaiting-approval" | "running") =>
  buildDeliveryGraphRunRow({
    runKey: "rk",
    digest: "d",
    status,
    sideEffecting: true,
    nodeCount: 1,
    humanNodeCount: 0,
    sideEffectCount: 1,
    title: "t",
    phase: status === "running" ? DELIVERY_PHASE.RUNNING : DELIVERY_PHASE.AWAITING_APPROVAL,
    processKey: null,
  });

test("claimRunForLaunch: an empty slot is won by INSERT; a second racer that also read empty loses the run_key PK fence", async () => {
  await withData(async (data) => {
    const claim = claimRow("running");
    assertEquals(await claimRunForLaunch(data, false, claim), true); // inserted the claim → this caller launches
    assertEquals(await claimRunForLaunch(data, false, claim), false); // the row now exists → PK fence, no second launch
    assertEquals((await deliveryGraphRuns(data).get("rk"))?.status, "running");
  });
});

test("claimRunForLaunch: a parked awaiting-approval row is claimed by ONE compare-and-swap — a second approved racer loses the `status <> 'running'` guard, so a graph launches at most once", async () => {
  await withData(async (data) => {
    const runs = deliveryGraphRuns(data);
    await runs.insert(claimRow("awaiting-approval")); // a prior unapproved POST parked this run
    const claim = claimRow("running");
    assertEquals(await claimRunForLaunch(data, true, claim), true); // CAS flips awaiting-approval → running
    assertEquals(await claimRunForLaunch(data, true, claim), false); // already running → guard blocks the double-launch
    assertEquals((await runs.get("rk"))?.status, "running");
  });
});

test("claimRunForLaunch: a TERMINAL row re-runs — the CAS flips it to running, and a concurrent re-run racer loses the guard", async () => {
  await withData(async (data) => {
    const runs = deliveryGraphRuns(data);
    await runs.insert({ ...claimRow("running"), status: "failed" }); // a completed/terminal prior run
    const claim = claimRow("running");
    assertEquals(await claimRunForLaunch(data, true, claim), true); // re-run: failed <> running → flips
    assertEquals(await claimRunForLaunch(data, true, claim), false); // now running → no second launch
    assertEquals((await runs.get("rk"))?.status, "running");
  });
});

test("claimRunForLaunch: re-running a terminal row clears the PRIOR instance key in the SAME atomic flip — a claimed `running` row is never visible pointing at a stale process_key", async () => {
  await withData(async (data) => {
    const runs = deliveryGraphRuns(data);
    // A terminal prior run still carrying its old instance key + parked-node projection.
    await runs.insert({
      ...claimRow("running"),
      status: "failed",
      process_key: "OLD-PI",
      process_definition_id: "OLD-DEF",
      phase: "Parked on human node: publish",
      phase_node_id: "delivery-human-task__n1",
    });
    // The fresh launch claim carries no instance key yet (processKey: null).
    assertEquals(await claimRunForLaunch(data, true, claimRow("running")), true);
    const row = await runs.get("rk");
    assertEquals(row?.status, "running");
    assertEquals(row?.process_key, null); // stale key cleared atomically with the flip — not left as "OLD-PI"
    assertEquals(row?.process_definition_id, null);
    assertEquals(row?.phase_node_id, null);
    assertEquals(row?.phase, DELIVERY_PHASE.RUNNING);
  });
});

// ── pollDeliveryGraphPhase: engine-key coercion ───────────────────────────────
test("pollDeliveryGraphPhase: a numeric engine processInstanceKey still matches the string process_key, so a COMPLETED instance reconciles to done", async () => {
  await withData(async (data) => {
    const runs = deliveryGraphRuns(data);
    await runs.insert({ ...claimRow("running"), process_key: "12345" });
    // The engine can yield a NUMERIC key; the poller compares against the string process_key.
    const engine = {
      searchProcessInstances: async () => [{ processInstanceKey: 12345, state: "COMPLETED" }],
      searchUserTasks: async () => [],
    };
    await pollDeliveryGraphPhase(data, engine as never);
    assertEquals((await runs.get("rk"))?.status, "done");
  });
});

// ── computeRunKey ─────────────────────────────────────────────────────────────
test("computeRunKey: a non-blank caller key wins; a blank/absent key falls back to the digest", () => {
  assertEquals(computeRunKey("run-1", "digestX"), "run-1");
  assertEquals(computeRunKey("  run-2  ", "digestX"), "run-2"); // trimmed
  assertEquals(computeRunKey("", "digestX"), "digestX");
  assertEquals(computeRunKey("   ", "digestX"), "digestX");
  assertEquals(computeRunKey(null, "digestX"), "digestX");
  assertEquals(computeRunKey(undefined, "digestX"), "digestX");
});

// ── buildHumanLabels / parseHumanLabels ───────────────────────────────────────
test("buildHumanLabels: maps each human node's compiled user-task element id → its instruction label", async () => {
  const graph = {
    nodes: [
      { id: "open-b", kind: "agent", agent: { jobType: "j" } },
      { id: "publish", kind: "human", human: { prompt: "run the manual OTP publish\nsecond line" } },
      { id: "ack", kind: "human" }, // no prompt → falls back to the node id
    ],
    edges: [{ from: "open-b", to: "publish" }, { from: "publish", to: "ack" }],
  };
  const compiled = await compileDeliveryGraph(graph);
  assertEquals(compiled.ok, true);
  if (!compiled.ok) return;
  const labels = buildHumanLabels(compiled);
  const publishEl = compiled.resolved.nodes.find((n) => n.id === "publish")?.element ?? "";
  const ackEl = compiled.resolved.nodes.find((n) => n.id === "ack")?.element ?? "";
  assertEquals(labels[humanTaskElementId(publishEl)], "run the manual OTP publish"); // first line only
  assertEquals(labels[humanTaskElementId(ackEl)], "ack"); // fallback to node id
});

test("parseHumanLabels: round-trips a stored map and tolerates null/blank/corrupt", () => {
  assertEquals(parseHumanLabels(JSON.stringify({ a: "x" })), { a: "x" });
  assertEquals(parseHumanLabels(null), {});
  assertEquals(parseHumanLabels(""), {});
  assertEquals(parseHumanLabels("  "), {});
  assertEquals(parseHumanLabels("{not json"), {});
  assertEquals(parseHumanLabels(JSON.stringify(["a"])), {}); // non-object
  assertEquals(parseHumanLabels(JSON.stringify({ a: 1, b: "y" })), { b: "y" }); // drops non-string values
});

// ── deriveDeliveryPhase ───────────────────────────────────────────────────────
test("deriveDeliveryPhase: COMPLETED → done, TERMINATED → failed", () => {
  assertEquals(deriveDeliveryPhase("COMPLETED", [], {}), { status: "done", phase: DELIVERY_PHASE.COMPLETED, phase_node_id: null });
  assertEquals(deriveDeliveryPhase("TERMINATED", [], {}), { status: "failed", phase: DELIVERY_PHASE.FAILED, phase_node_id: null });
});

test("deriveDeliveryPhase: ACTIVE with an open human task → parked on that node with its label", () => {
  const el = humanTaskElementId("n2");
  const p = deriveDeliveryPhase("ACTIVE", [{ elementId: el }], { [el]: "manual OTP publish" });
  assertEquals(p.status, "running");
  assertEquals(p.phase, "Parked on human node: manual OTP publish");
  assertEquals(p.phase_node_id, el);
});

test("deriveDeliveryPhase: a parked node with no stored label falls back to the element id", () => {
  const el = humanTaskElementId("n5");
  const p = deriveDeliveryPhase("ACTIVE", [{ elementId: el }], {});
  assertEquals(p.phase, `Parked on human node: ${el}`);
  assertEquals(p.phase_node_id, el);
});

test("deriveDeliveryPhase: ACTIVE with only a non-human open task (or none) → a bare Running", () => {
  assertEquals(deriveDeliveryPhase("ACTIVE", [], {}), { status: "running", phase: DELIVERY_PHASE.RUNNING, phase_node_id: null });
  assertEquals(deriveDeliveryPhase("ACTIVE", [{ elementId: "some-service-task" }], {}), {
    status: "running",
    phase: DELIVERY_PHASE.RUNNING,
    phase_node_id: null,
  });
  // A null state (instance not found this pass) is treated as still-running, never a false terminal.
  assertEquals(deriveDeliveryPhase(null, [], {}), { status: "running", phase: DELIVERY_PHASE.RUNNING, phase_node_id: null });
});

test("deriveDeliveryPhase: multiple open human tasks pick the lowest element id deterministically", () => {
  const a = humanTaskElementId("n1");
  const b = humanTaskElementId("n3");
  const p = deriveDeliveryPhase("ACTIVE", [{ elementId: b }, { elementId: a }], { [a]: "first", [b]: "second" });
  assertEquals(p.phase, "Parked on human node: first");
  assertEquals(p.phase_node_id, a);
});
