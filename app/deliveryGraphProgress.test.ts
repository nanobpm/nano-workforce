// Unit coverage for the per-node progress projection of a running delivery graph (issue #1055):
// engine element instances / variables / user tasks / incidents → per-node state, bound facts, last
// probe, child PR run keys and open escalation.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveNodeProgress,
  ENGINE_SEARCH_PAGE,
  type ElementInstanceFact,
  owningNodeElement,
  prKeyOf,
  type ResolvedNodeRef,
  readEngineFacts,
  renderProgressMermaid,
  type VariableFact,
} from "./deliveryGraphProgress.ts";

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

test("lastProbe never attributes a run-root probe result (no provenance) to a wait", () => {
  const base = {
    nodes: NODES,
    processInstanceKey: PIK,
    variables: [
      { name: "ready", value: "true", scopeKey: PIK },
      { name: "detail", value: '"merged"', scopeKey: PIK },
    ],
    userTasks: [],
    incidents: [],
  };
  // Wait A (n0) completed with a root-propagated result; wait B (n2) just started and has not probed.
  const out = deriveNodeProgress({
    ...base,
    elements: [
      { elementId: "n0", elementInstanceKey: "1", state: "COMPLETED" },
      { elementId: "n2", elementInstanceKey: "3", state: "ACTIVE" },
      { elementId: "n2_probeLoop", elementInstanceKey: "5", state: "ACTIVE" },
    ],
  });
  assert.equal(out.find((n) => n.id === "landed")?.lastProbe, null);
  assert.equal(out.find((n) => n.id === "gate")?.lastProbe, null);
});

test("an expired wait's `__esc__wait` twin is classified as a timeout escalation", () => {
  const out = deriveNodeProgress({
    nodes: NODES,
    processInstanceKey: PIK,
    elements: [{ elementId: "n2", elementInstanceKey: "3", state: "ACTIVE" }],
    variables: [],
    userTasks: [{ userTaskKey: "u9", elementId: "delivery-human-task__n2__esc__wait" }],
    incidents: [],
  });
  const landed = out.find((n) => n.id === "landed");
  assert.equal(landed?.escalation?.reason, "timeout");
  assert.equal(landed?.state, "escalated");
});

test("a no-emits converge connector reports the PR it resolved from its task-local inputs", () => {
  const nodes = [{ id: "merge", kind: "connector" as const, element: "n5", emits: [], dependsOn: [] }];
  const mk = (payload: string, boundFacts: string) =>
    deriveNodeProgress({
      nodes,
      processInstanceKey: PIK,
      elements: [
        { elementId: "n5", elementInstanceKey: "50", state: "COMPLETED" },
        { elementId: "n5_connector", elementInstanceKey: "51", state: "COMPLETED" },
      ],
      variables: [
        { name: "target", value: '"converge-merge"', scopeKey: "51" },
        { name: "payload", value: payload, scopeKey: "51" },
        { name: "boundFacts", value: boundFacts, scopeKey: "51" },
      ],
      userTasks: [],
      incidents: [],
    })[0]?.childRunKeys;
  assert.deepEqual(mk('{"pr":"o/r#7"}', "[]"), ["o/r#7"]);
  assert.deepEqual(mk("{}", '[{"from":"impl","name":"pr","value":"https://github.com/o/r/pull/8"}]'), ["o/r#8"]);
  assert.deepEqual(mk('{"pr":"impl.pr"}', '[{"from":"impl","name":"pr","value":"o/r#9"}]'), ["o/r#9"]);
});

test("lastProbe reads the node element scope when the result propagated there", () => {
  const out = deriveNodeProgress({
    nodes: NODES,
    processInstanceKey: PIK,
    elements: [
      { elementId: "n0", elementInstanceKey: "1", state: "ACTIVE" },
      { elementId: "n2", elementInstanceKey: "3", state: "ACTIVE" },
    ],
    variables: [{ name: "ready", value: "true", scopeKey: "3" }],
    userTasks: [],
    incidents: [],
  });
  assert.deepEqual(out.find((n) => n.id === "landed")?.lastProbe, { ready: true, detail: null, observed: null });
});

test("an agent's node-local PR result is visible (no-emits agent, and an emitting agent before publish)", () => {
  for (const emits of [[], [{ name: "pr", type: "pr" }]]) {
    for (const name of ["pr", "prUrl", "pullRequest"]) {
      const out = deriveNodeProgress({
        nodes: [{ id: "impl", kind: "agent", element: "n7", emits, dependsOn: [] }],
        processInstanceKey: PIK,
        elements: [
          { elementId: "n7", elementInstanceKey: "70", state: "ACTIVE" },
          { elementId: "n7_task", elementInstanceKey: "71", state: "COMPLETED" },
        ],
        variables: [{ name, value: '"https://github.com/o/r/pull/11"', scopeKey: "70" }],
        userTasks: [],
        incidents: [],
      });
      assert.deepEqual(out[0]?.childRunKeys, ["o/r#11"], `${name} with ${emits.length} emits`);
    }
  }
});

test("truncated variable previews are treated as absent, never parsed as complete values", () => {
  const out = deriveNodeProgress({
    nodes: NODES,
    processInstanceKey: PIK,
    elements: [
      { elementId: "n1", elementInstanceKey: "2", state: "COMPLETED" },
      { elementId: "n2", elementInstanceKey: "3", state: "ACTIVE" },
    ],
    variables: [
      { name: "n2_mergedSha", value: '"abc', scopeKey: PIK, isTruncated: true },
      { name: "n1_pr", value: '"o/r#1', scopeKey: PIK, isTruncated: true },
      { name: "ready", value: "tr", scopeKey: "3", isTruncated: true },
    ],
    userTasks: [],
    incidents: [],
  });
  const landed = out.find((n) => n.id === "landed");
  assert.deepEqual(landed?.boundFacts, {});
  assert.equal(landed?.lastProbe, null);
  assert.deepEqual(out.find((n) => n.id === "build")?.childRunKeys, []);
});

test("a __proto__ fact name or wait-node id is kept as an own property, not swallowed by the prototype setter", () => {
  const nodes = deriveNodeProgress({
    nodes: [
      { id: "__proto__", kind: "wait", element: "n0", emits: [], dependsOn: [] },
      { id: "b", kind: "agent", element: "n1", emits: [{ name: "__proto__", type: "string" }], dependsOn: [] },
    ],
    processInstanceKey: PIK,
    elements: [{ elementId: "n1", elementInstanceKey: "2", state: "COMPLETED" }],
    variables: [{ name: "n1___proto__", value: '"x"', scopeKey: PIK }],
    userTasks: [],
    incidents: [],
    pollEveryByNode: JSON.parse('{"__proto__":"PT1M"}'),
  });
  assert.equal(Object.hasOwn(nodes[1]?.boundFacts ?? {}, "__proto__"), true);
  assert.equal(JSON.stringify(nodes[1]?.boundFacts), '{"__proto__":"x"}');
  assert.equal(nodes[0]?.pollEvery, "PT1M");
});

test("an unconfigured wait node never reads an inherited cadence", () => {
  const nodes = deriveNodeProgress({
    nodes: [{ id: "constructor", kind: "wait", element: "n0", emits: [], dependsOn: [] }],
    processInstanceKey: PIK, elements: [], variables: [], userTasks: [], incidents: [], pollEveryByNode: {},
  });
  assert.equal(nodes[0]?.pollEvery, null);
});

/** A fake engine that, like the real one behind the urban client, answers every search with ONE page. */
function pagedEngine(all: { elements: ElementInstanceFact[]; variables: VariableFact[] }) {
  const one = <T>(rows: T[]): T[] => rows.slice(0, ENGINE_SEARCH_PAGE);
  return {
    searchProcessInstances: async () => [{ state: "ACTIVE" }],
    searchElementInstances: async (f: { elementId?: string; state?: string } = {}) =>
      one(all.elements.filter((e) => (f.elementId === undefined || e.elementId === f.elementId) && (f.state === undefined || e.state === f.state)).map((e) => ({ ...e, processInstanceKey: PIK }))),
    getElementInstance: async (k: string) => {
      const e = all.elements.find((x) => x.elementInstanceKey === k);
      return e ? { ...e, processInstanceKey: PIK } : null;
    },
    searchVariables: async (f: { scopeKey?: string; name?: string } = {}) =>
      one(
        all.variables
          .filter((v) => (f.scopeKey === undefined || v.scopeKey === f.scopeKey) && (f.name === undefined || v.name === f.name))
          .map((v, i) => ({ ...v, variableKey: String(i), processInstanceKey: PIK, isTruncated: false })),
      ),
    searchUserTasks: async () => [],
    searchIncidents: async () => [],
  };
}

test("a run with more variables and element instances than one page still yields complete facts and states", async () => {
  const elements: ElementInstanceFact[] = [
    { elementId: "n0", elementInstanceKey: "1", state: "COMPLETED" },
    { elementId: "n1", elementInstanceKey: "2", state: "COMPLETED" },
    { elementId: "n1_task", elementInstanceKey: "3", state: "COMPLETED" },
    { elementId: "n2", elementInstanceKey: "4", state: "ACTIVE" },
  ];
  const variables: VariableFact[] = [];
  // 300 unrelated element instances and variables listed FIRST: a single broad page would hold only these.
  for (let i = 0; i < 300; i++) {
    elements.unshift({ elementId: `other_${i}`, elementInstanceKey: String(1000 + i), state: "COMPLETED" });
    variables.push({ name: `noise${i}`, value: "1", scopeKey: PIK });
  }
  // Probe-loop iterations listed newest-FIRST: the newest scope (highest key) must win, not array order.
  elements.push({ elementId: "n2_probeLoop", elementInstanceKey: "9", state: "ACTIVE" }, { elementId: "n2_probeLoop", elementInstanceKey: "5", state: "COMPLETED" });
  variables.push(
    { name: "ready", value: "false", scopeKey: "9" },
    { name: "detail", value: '"newest"', scopeKey: "9" },
    { name: "ready", value: "true", scopeKey: "5" },
    { name: "detail", value: '"stale"', scopeKey: "5" },
    { name: "n1_pr", value: '"a/b#7"', scopeKey: PIK },
    { name: "pr", value: '"a/b#8"', scopeKey: "3" },
    { name: "nodeInputs", value: JSON.stringify({ n2: { probePollEvery: "PT5M" } }), scopeKey: PIK },
  );
  const read = await readEngineFacts(pagedEngine({ elements, variables }), PIK, NODES);
  assert.equal(read.truncated, false);
  const nodes = deriveNodeProgress({ nodes: NODES, processInstanceKey: PIK, ...read, pollEveryByNode: { landed: "PT5M" } });
  const by = new Map(nodes.map((n) => [n.id, n]));
  assert.equal(by.get("gate")?.state, "satisfied");
  assert.equal(by.get("build")?.state, "satisfied");
  assert.deepEqual(by.get("build")?.boundFacts, { pr: "a/b#7" });
  assert.deepEqual(by.get("build")?.childRunKeys, ["a/b#7", "a/b#8"]);
  assert.equal(by.get("landed")?.state, "active");
  assert.deepEqual(by.get("landed")?.lastProbe, { ready: false, detail: "newest", observed: null });
});

test("a narrowed read that still fills a whole page is reported as truncated", async () => {
  const elements: ElementInstanceFact[] = [{ elementId: "n2", elementInstanceKey: "4", state: "ACTIVE" }];
  const variables: VariableFact[] = [];
  for (let i = 0; i < ENGINE_SEARCH_PAGE + 5; i++) {
    elements.push({ elementId: "n2_probeLoop", elementInstanceKey: String(10 + i), state: "COMPLETED" });
    variables.push({ name: "ready", value: "false", scopeKey: String(10 + i) });
  }
  const read = await readEngineFacts(pagedEngine({ elements, variables }), PIK, NODES);
  assert.equal(read.truncated, true);
});

test("the newest probe scope is chosen by numeric (BigInt) key order, never lexical order", () => {
  for (const [older, newer] of [["9", "10"], ["2251799813685249", "2251799813685250"]] as const) {
    const out = deriveNodeProgress({
      nodes: NODES,
      processInstanceKey: PIK,
      elements: [
        { elementId: "n2", elementInstanceKey: "3", state: "ACTIVE" },
        { elementId: "n2_probeLoop", elementInstanceKey: newer, state: "ACTIVE" },
        { elementId: "n2_probeLoop", elementInstanceKey: older, state: "COMPLETED" },
      ],
      variables: [
        { name: "ready", value: "true", scopeKey: older },
        { name: "detail", value: '"stale"', scopeKey: older },
        { name: "ready", value: "false", scopeKey: newer },
        { name: "detail", value: '"newest"', scopeKey: newer },
      ],
      userTasks: [],
      incidents: [],
    });
    assert.deepEqual(out.find((n) => n.id === "landed")?.lastProbe, { ready: false, detail: "newest", observed: null }, `${older} vs ${newer}`);
  }
});

test("a wait with more than one page of probe iterations still reports its newest probe", async () => {
  const elements: ElementInstanceFact[] = [{ elementId: "n2", elementInstanceKey: "4", state: "ACTIVE" }];
  const variables: VariableFact[] = [];
  const iterations = ENGINE_SEARCH_PAGE * 3;
  // Oldest-first: the one-page history holds only stale iterations.
  for (let i = 0; i < iterations; i++) {
    const key = String(2251799813685000 + i);
    const newest = i === iterations - 1;
    elements.push({ elementId: "n2_probeLoop", elementInstanceKey: key, state: newest ? "ACTIVE" : "COMPLETED" });
    variables.push({ name: "ready", value: "false", scopeKey: key }, { name: "detail", value: JSON.stringify(newest ? "newest" : `old ${i}`), scopeKey: key });
  }
  const read = await readEngineFacts(pagedEngine({ elements, variables }), PIK, NODES);
  const landed = deriveNodeProgress({ nodes: NODES, processInstanceKey: PIK, ...read }).find((n) => n.id === "landed");
  assert.deepEqual(landed?.lastProbe, { ready: false, detail: "newest", observed: null });
});

test("a newest probe iteration that has not written `ready` yet falls back to the previous one", async () => {
  const elements: ElementInstanceFact[] = [
    { elementId: "n2", elementInstanceKey: "4", state: "ACTIVE" },
    { elementId: "n2_probeLoop", elementInstanceKey: "10", state: "COMPLETED" },
    { elementId: "n2_probeLoop", elementInstanceKey: "11", state: "ACTIVE" },
  ];
  const variables: VariableFact[] = [
    { name: "ready", value: "true", scopeKey: "10" },
    { name: "detail", value: '"previous"', scopeKey: "10" },
  ];
  const read = await readEngineFacts(pagedEngine({ elements, variables }), PIK, NODES);
  const landed = deriveNodeProgress({ nodes: NODES, processInstanceKey: PIK, ...read }).find((n) => n.id === "landed");
  assert.deepEqual(landed?.lastProbe, { ready: true, detail: "previous", observed: null });
});
