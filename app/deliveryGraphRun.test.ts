// Unit coverage for the S5 dispatch-door aggregate (ADR 0005 Decision 7) — the pure decision helpers
// (the idempotency key, the approval gate, the parked human-label map, the derived parked-node phase),
// plus the durable at-most-once launch-claim fence (`claimRunForLaunch`) exercised against the real
// provisioned SQLite data layer so its actual `status <> 'running'` compare-and-swap SQL is validated,
// not just modelled. The integration test (operations/startDeliveryGraph.integration.test.ts) proves
// the COMPOSED behaviour at the edge.
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
  isDeliveryGraphApproved,
  parseHumanLabels,
} from "./deliveryGraphRun.ts";

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

// ── computeRunKey ─────────────────────────────────────────────────────────────
test("computeRunKey: a non-blank caller key wins; a blank/absent key falls back to the digest", () => {
  assertEquals(computeRunKey("run-1", "digestX"), "run-1");
  assertEquals(computeRunKey("  run-2  ", "digestX"), "run-2"); // trimmed
  assertEquals(computeRunKey("", "digestX"), "digestX");
  assertEquals(computeRunKey("   ", "digestX"), "digestX");
  assertEquals(computeRunKey(null, "digestX"), "digestX");
  assertEquals(computeRunKey(undefined, "digestX"), "digestX");
});

// ── isDeliveryGraphApproved ───────────────────────────────────────────────────
test("isDeliveryGraphApproved: a non-side-effecting graph needs no approval", () => {
  assertEquals(isDeliveryGraphApproved(false, null, "d"), true);
  assertEquals(isDeliveryGraphApproved(false, "wrong", "d"), true);
});

test("isDeliveryGraphApproved: a side-effecting graph dispatches ONLY with the matching content token", () => {
  assertEquals(isDeliveryGraphApproved(true, "d", "d"), true);
  assertEquals(isDeliveryGraphApproved(true, "  d  ", "d"), true); // trimmed
  assertEquals(isDeliveryGraphApproved(true, "wrong", "d"), false);
  assertEquals(isDeliveryGraphApproved(true, null, "d"), false);
  assertEquals(isDeliveryGraphApproved(true, "", "d"), false);
});

// ── buildHumanLabels / parseHumanLabels ───────────────────────────────────────
test("buildHumanLabels: maps each human node's compiled user-task element id → its instruction label", () => {
  const graph = {
    nodes: [
      { id: "open-b", kind: "agent", agent: { jobType: "j" } },
      { id: "publish", kind: "human", human: { prompt: "run the manual OTP publish\nsecond line" } },
      { id: "ack", kind: "human" }, // no prompt → falls back to the node id
    ],
    edges: [{ from: "open-b", to: "publish" }, { from: "publish", to: "ack" }],
  };
  const compiled = compileDeliveryGraph(graph);
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
