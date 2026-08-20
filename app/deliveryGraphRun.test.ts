// Unit coverage for the pure decision helpers of the S5 dispatch-door aggregate (ADR 0005 Decision 7)
// — the idempotency key, the approval gate, the parked human-label map, and the derived parked-node
// phase. All engine/DB-free, so they prove the door's decisions in isolation; the integration test
// (operations/startDeliveryGraph.integration.test.ts) proves the COMPOSED behaviour at the edge.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { compileDeliveryGraph } from "./deliveryGraphCompiler.ts";
import {
  buildHumanLabels,
  computeRunKey,
  deriveDeliveryPhase,
  DELIVERY_PHASE,
  humanTaskElementId,
  isDeliveryGraphApproved,
  parseHumanLabels,
} from "./deliveryGraphRun.ts";

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
