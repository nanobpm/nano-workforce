// Unit coverage for the per-node progress projection of a running delivery graph (issue #1055):
// engine element instances / variables / user tasks / incidents → per-node state, bound facts, last
// probe, child PR run keys and open escalation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveNodeProgress, owningNodeElement, prKeyOf, type ResolvedNodeRef, renderProgressMermaid } from "./deliveryGraphProgress.ts";

const PIK = "100";
const NODES: ResolvedNodeRef[] = [
  { id: "gate", kind: "wait", element: "n0", emits: [], dependsOn: [] },
  { id: "build", kind: "agent", element: "n1", emits: [{ name: "pr", type: "pr" }], dependsOn: ["gate"] },
  { id: "landed", kind: "wait", element: "n2", emits: [{ name: "mergedSha", type: "string" }], dependsOn: ["build"] },
  { id: "ok", kind: "human", element: "n3", emits: [], dependsOn: ["landed"] },
];

test("owningNodeElement maps inner and human-task element ids to their node element", () => {
  const els = new Set(["n1", "n12"]);
  assert.equal(owningNodeElement("n1", els), "n1");
  assert.equal(owningNodeElement("n1_task", els), "n1");
  assert.equal(owningNodeElement("n12_probeLoop", els), "n12");
  assert.equal(owningNodeElement("delivery-human-task__n12__esc", els), "n12");
  assert.equal(owningNodeElement("delivery-human-task__n1", els), "n1");
  assert.equal(owningNodeElement("Start", els), null);
  assert.equal(owningNodeElement("gwj_end", els), null);
});

test("prKeyOf normalises keys, URLs and objects", () => {
  assert.equal(prKeyOf("nanobpm/nano-coder#340"), "nanobpm/nano-coder#340");
  assert.equal(prKeyOf("https://github.com/nanobpm/nano-coder/pull/340"), "nanobpm/nano-coder#340");
  assert.equal(prKeyOf({ url: "https://github.com/a/b/pull/2" }), "a/b#2");
  assert.equal(prKeyOf("not a pr"), null);
  assert.equal(prKeyOf(7), null);
});

test("derives satisfied / active / pending, bound facts, child runs and the last probe", () => {
  const nodes = deriveNodeProgress({
    nodes: NODES,
    processInstanceKey: PIK,
    elements: [
      { elementId: "n0", elementInstanceKey: "1", state: "COMPLETED" },
      { elementId: "n1", elementInstanceKey: "2", state: "COMPLETED" },
      { elementId: "n2", elementInstanceKey: "3", state: "ACTIVE" },
      { elementId: "n2_probeLoop", elementInstanceKey: "4", state: "COMPLETED" },
      { elementId: "n2_probeLoop", elementInstanceKey: "5", state: "ACTIVE" },
      { elementId: "n2_waitPoll", elementInstanceKey: "6", state: "ACTIVE" },
    ],
    variables: [
      { name: "n1_pr", value: '"nanobpm/nano-coder#340"', scopeKey: PIK },
      { name: "ready", value: "false", scopeKey: "4" },
      { name: "detail", value: '"open"', scopeKey: "4" },
      { name: "ready", value: "false", scopeKey: "5" },
      { name: "detail", value: '"still open"', scopeKey: "5" },
      { name: "observed", value: '{"prState":"open"}', scopeKey: "5" },
    ],
    userTasks: [],
    incidents: [],
    pollEveryByNode: { landed: "PT5M" },
  });
  const by = new Map(nodes.map((n) => [n.id, n]));
  assert.equal(by.get("gate")?.state, "satisfied");
  assert.equal(by.get("build")?.state, "satisfied");
  assert.deepEqual(by.get("build")?.boundFacts, { pr: "nanobpm/nano-coder#340" });
  assert.deepEqual(by.get("build")?.childRunKeys, ["nanobpm/nano-coder#340"]);
  const landed = by.get("landed");
  assert.equal(landed?.state, "active");
  assert.deepEqual(landed?.activeElements, ["n2_probeLoop", "n2_waitPoll"]);
  assert.deepEqual(landed?.lastProbe, { ready: false, detail: "still open", observed: { prState: "open" } });
  assert.equal(landed?.pollEvery, "PT5M");
  assert.equal(by.get("ok")?.state, "pending");
  assert.equal(by.get("ok")?.pollEvery, null);
});

test("an escalation twin parks the node as escalated; a human node's own task stays active", () => {
  const nodes = deriveNodeProgress({
    nodes: NODES,
    processInstanceKey: PIK,
    elements: [
      { elementId: "n1", elementInstanceKey: "2", state: "ACTIVE" },
      { elementId: "delivery-human-task__n1__esc", elementInstanceKey: "7", state: "ACTIVE" },
      { elementId: "n3", elementInstanceKey: "8", state: "ACTIVE" },
      { elementId: "delivery-human-task__n3", elementInstanceKey: "9", state: "ACTIVE" },
    ],
    variables: [],
    userTasks: [
      { userTaskKey: "u1", elementId: "delivery-human-task__n1__esc" },
      { userTaskKey: "u2", elementId: "delivery-human-task__n3" },
    ],
    incidents: [],
  });
  const by = new Map(nodes.map((n) => [n.id, n]));
  assert.equal(by.get("build")?.state, "escalated");
  assert.deepEqual(by.get("build")?.escalation, { userTaskKey: "u1", elementId: "delivery-human-task__n1__esc", reason: "timeout" });
  assert.equal(by.get("ok")?.state, "active");
  assert.equal(by.get("ok")?.escalation?.reason, "human");
});

test("an incident fails the node; an ended instance skips unreached nodes; a terminated body is skipped", () => {
  const nodes = deriveNodeProgress({
    nodes: NODES,
    processInstanceKey: PIK,
    elements: [
      { elementId: "n0", elementInstanceKey: "1", state: "TERMINATED" },
      { elementId: "n1", elementInstanceKey: "2", state: "ACTIVE" },
      { elementId: "n1_task", elementInstanceKey: "3", state: "ACTIVE" },
    ],
    variables: [],
    userTasks: [],
    incidents: [{ incidentKey: "i1", elementId: "n1_task", errorType: "JOB_NO_RETRIES", errorMessage: "boom" }],
    instanceEnded: true,
  });
  const by = new Map(nodes.map((n) => [n.id, n]));
  assert.equal(by.get("gate")?.state, "skipped");
  assert.equal(by.get("build")?.state, "failed");
  assert.deepEqual(by.get("build")?.incident, { incidentKey: "i1", elementId: "n1_task", errorType: "JOB_NO_RETRIES", errorMessage: "boom" });
  assert.deepEqual(by.get("build")?.activeElements, ["n1_task"]);
  assert.equal(by.get("ok")?.state, "skipped");
});

test("renderProgressMermaid appends one state class per node", () => {
  const nodes = deriveNodeProgress({ nodes: NODES, processInstanceKey: PIK, elements: [], variables: [], userTasks: [], incidents: [] });
  const out = renderProgressMermaid('flowchart TD\n  n0["gate"]\n', nodes);
  assert.match(out, /classDef active /);
  assert.match(out, /\n {2}class n0 pending\n/);
  assert.match(out, /\n {2}class n3 pending\n$/);
});
