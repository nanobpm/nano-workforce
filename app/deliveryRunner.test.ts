// Unit coverage for the delivery-graph RUNNER's PURE prepare step (ADR 0005 slice S4). `prepareDeliveryGraph`
// compiles a graph, content-addresses its deploy id, rewrites the base process id, and builds the
// `nodeInputs` seed — all without touching the engine. These tests pin, directly:
//   • the content-addressed id (`delivery-graph-<sha12>`), and that it is DETERMINISTIC (same graph → same
//     id) but CONTENT-SENSITIVE (a different graph → a different id) — the property that makes redeploy
//     idempotent and stale definitions GC-identifiable (the ADR definition-lifecycle open question),
//   • the base process id is rewritten to the content-addressed id in the deployable BPMN,
//   • each node kind seeds the exact `nodeInputs` fields its compiled subProcess ioMapping reads,
//   • a malformed graph returns the S1 compile errors and prepares nothing.
// The engine-native EXECUTION of a prepared graph (deploy + run + gate + fan-in + late-bind + dedupe) is
// proven end-to-end in `e2e/delivery-graph.e2e.ts`.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { prepareDeliveryGraph, runDeliveryGraph } from "./deliveryRunner.ts";
import type { DeliveryGraph } from "../nano-generated/api-io.d.ts";

const GRAPH: DeliveryGraph = {
  name: "release runbook",
  nodes: [
    { id: "open-b", kind: "agent", agent: { jobType: "senior:feature", prompt: "un-draft + merge #B" } },
    { id: "watch-b", kind: "wait", wait: { kind: "pr", target: "owner/repo#42", match: { prState: "merged" } }, emits: [{ name: "mergedSha", type: "string" }] },
    { id: "publish", kind: "human", human: { prompt: "run the manual OTP publish" }, emits: [{ name: "resolvedArtifact", type: "artifact" }] },
    { id: "consume", kind: "connector", connector: { target: "npm:install", dedupeKey: "consume-1" } },
  ],
  edges: [
    { from: "open-b", to: "watch-b" },
    { from: "watch-b.mergedSha", to: "publish" },
    { from: "publish.resolvedArtifact", to: "consume" },
  ],
};

async function prepareOk(graph: DeliveryGraph, options = {}) {
  const r = await prepareDeliveryGraph(graph, options);
  assert(r.ok, `expected ok:true, got ${JSON.stringify(r)}`);
  return r.prepared;
}

test("content-addressed id: deterministic for the same graph, content-sensitive across graphs", async () => {
  const a = await prepareOk(GRAPH);
  const b = await prepareOk(GRAPH);
  assert(/^delivery-graph-[0-9a-f]{12}$/.test(a.processDefinitionId), `id is content-addressed, got ${a.processDefinitionId}`);
  assertEquals(a.processDefinitionId, b.processDefinitionId);

  // A structurally different graph gets a DIFFERENT id (no collision / no accidental redeploy-as-same).
  const other = await prepareOk({ ...GRAPH, nodes: [...GRAPH.nodes, { id: "extra", kind: "agent", agent: { jobType: "senior:feature" } }], edges: [...GRAPH.edges, { from: "consume", to: "extra" }] });
  assert(other.processDefinitionId !== a.processDefinitionId, "a different graph yields a different id");
});

test("the deployable BPMN rewrites the base process id to the content-addressed deploy id", async () => {
  const p = await prepareOk(GRAPH);
  assert(p.bpmn.includes(`<bpmn:process id="${p.processDefinitionId}"`), "process id is the content-addressed id");
  assert(!p.bpmn.includes('<bpmn:process id="delivery-graph"'), "the base id no longer appears as the process id");
});

test("DI (#440): the deployable definition carries diagram interchange bound to the rewritten process id", async () => {
  // The DEPLOYED definition (not just the compile preview) must render in the process explorer, so it
  // carries the auto-laid-out `bpmndi:BPMNDiagram`. The top-level plane's `bpmnElement` reference is
  // rewritten in lock-step with the process id, otherwise the deployed diagram would dangle and render
  // positionless — the exact bug #440 fixes.
  const p = await prepareOk(GRAPH);
  assert(p.bpmn.includes("<bpmndi:BPMNDiagram"), "deployable bpmn carries a diagram");
  assert(p.bpmn.includes(`bpmnElement="${p.processDefinitionId}"`), "the plane binds to the content-addressed id");
  assert(!p.bpmn.includes('bpmnElement="delivery-graph"'), "no dangling reference to the base process id remains");
});

test("nodeInputs seeds the exact per-kind fields each node's subProcess ioMapping reads", async () => {
  const p = await prepareOk(GRAPH, { nodeTimeout: "PT10M", probeTimeout: "PT20M", escalationSlaTimeout: "PT2H", escalationAssignee: "alice", runKey: "run-7" });
  // Element ids are positional by sorted node id: consume, open-b, publish, watch-b → n0..n3.
  const inputs = p.nodeInputs;
  const byField = (pred: (v: Record<string, unknown>) => boolean) => Object.values(inputs).find((v) => pred(v as Record<string, unknown>)) as Record<string, unknown> | undefined;

  const agent = byField((v) => v.jobType === "senior:feature");
  assertEquals(agent, { jobType: "senior:feature", appendPrompt: "un-draft + merge #B", timeout: "PT10M" });

  const wait = byField((v) => "gateKey" in v);
  assertEquals(wait?.gateKey, "run-7:n3");
  assertEquals(wait?.probeTimeout, "PT20M");
  assertEquals(wait?.probePollEvery, "PT15S");
  assert(wait?.probe && typeof wait.probe === "object", "the wait node carries its ReadinessProbe descriptor");

  const human = byField((v) => "escalationSlaTimeout" in v);
  assertEquals(human, {
    escalationSlaTimeout: "PT2H",
    escalationAssignee: "alice",
    // #499: the human node seeds its authored prompt, node identity, and declared emits so the
    // generic user-task form renders "now do X", names the parked node, and labels its emit field.
    prompt: "run the manual OTP publish",
    nodeId: "publish",
    emits: [{ name: "resolvedArtifact", type: "artifact" }],
  });

  const connector = byField((v) => v.target === "npm:install");
  assertEquals(connector, { target: "npm:install", dedupeKey: "consume-1", payload: null, timeout: "PT10M" });
});

test("the human node seeds prompt/nodeId/emits; a click-done (no-emit, no-prompt) node seeds empty defaults", async () => {
  // #499: the compiled human user-task's form reads `prompt`/`nodeId`/`emits` from `nodeInputs.<el>`;
  // a discarded prompt is the contextless-form bug. Pin both an emit-declaring node and the degenerate
  // click-done node (no `human` config, no `emits`) so the seed never regresses to null/undefined.
  const graph: DeliveryGraph = {
    nodes: [
      { id: "publish", kind: "human", human: { prompt: "run the manual OTP publish" }, emits: [{ name: "resolvedArtifact", type: "artifact" }] },
      { id: "ack", kind: "human" },
    ],
    edges: [{ from: "publish.resolvedArtifact", to: "ack" }],
  };
  const p = await prepareOk(graph);
  const humans = Object.values(p.nodeInputs).filter((v) => "escalationSlaTimeout" in v) as Array<Record<string, unknown>>;
  const publish = humans.find((v) => v.nodeId === "publish");
  const ack = humans.find((v) => v.nodeId === "ack");

  assertEquals(publish?.prompt, "run the manual OTP publish");
  assertEquals(publish?.emits, [{ name: "resolvedArtifact", type: "artifact" }]);

  // The click-done node carries a defined-but-empty prompt and an empty emits list (never undefined),
  // so the form seeds a blank instruction and hides its emit field rather than seeding null.
  assertEquals(ack?.prompt, "");
  assertEquals(ack?.emits, []);
  assertEquals(ack?.nodeId, "ack");
});

test("wait gateKeys default to a fresh per-run token so concurrent runs of one graph never cross-correlate", async () => {
  const gateKeyOf = (p: Awaited<ReturnType<typeof prepareOk>>) =>
    (Object.values(p.nodeInputs).find((v) => "gateKey" in v) as { gateKey?: string } | undefined)?.gateKey;

  const a = await prepareOk(GRAPH);
  const b = await prepareOk(GRAPH);
  assert(gateKeyOf(a) && gateKeyOf(b), "each run seeds a wait gateKey");
  assert(gateKeyOf(a) !== gateKeyOf(b), "two runs of the same graph get DISTINCT default gate scopes");
  // The gate key must NOT be derived from the (shared) content digest — that is the bug this guards.
  assert(!gateKeyOf(a)?.startsWith(a.processDefinitionId.slice(-12)), "default gateKey is not the graph digest");
  // The deployable definition (id + bpmn) stays deterministic regardless of the per-run gate scope.
  assertEquals(a.processDefinitionId, b.processDefinitionId);
  assertEquals(a.bpmn, b.bpmn);

  // An explicit runKey is honoured verbatim (reproducible seed).
  const seeded = await prepareOk(GRAPH, { runKey: "run-7" });
  assertEquals(gateKeyOf(seeded), "run-7:n3");
});

test("the node timeout defaults to PT1H (raised from PT30M) when no option is supplied (#505)", async () => {
  // #505: the hard PT30M default tripped the boundary timer on legitimately-long implementation nodes.
  // With no timeout option, every agent/connector node inherits the NEW PT1H run default.
  const p = await prepareOk(GRAPH);
  const timeouts = Object.values(p.nodeInputs)
    .filter((v) => "timeout" in v)
    .map((v) => (v as { timeout: string }).timeout);
  assert(timeouts.length === 2, `expected the agent + connector nodes to seed a timeout, got ${timeouts.length}`);
  for (const t of timeouts) assertEquals(t, "PT1H");
});

test("a submission nodeTimeout override seeds every agent/connector node with that duration (#505)", async () => {
  // AC: an operator dispatch that sets nodeTimeout: "PT2H" seeds PT2H for ALL agent/connector nodes.
  const p = await prepareOk(GRAPH, { nodeTimeout: "PT2H" });
  const timeouts = Object.values(p.nodeInputs)
    .filter((v) => "timeout" in v)
    .map((v) => (v as { timeout: string }).timeout);
  assert(timeouts.length === 2, `expected two seeded node timeouts, got ${timeouts.length}`);
  for (const t of timeouts) assertEquals(t, "PT2H");
});

test("a per-node timeout override wins for its node while siblings keep the run/default value (#505)", async () => {
  // AC: a node declaring timeout: "PT4H" seeds nodeInputs.<el>.timeout == "PT4H" while its siblings keep
  // the run-level (here PT2H) value. Asserted positionally on the compiled nodeInputs map.
  const graph: DeliveryGraph = {
    name: "per-node override",
    nodes: [
      { id: "heavy", kind: "agent", agent: { jobType: "senior:feature", prompt: "long build", timeout: "PT4H" } },
      { id: "quick", kind: "agent", agent: { jobType: "senior:demo" } },
      { id: "notify", kind: "connector", connector: { target: "slack:post", dedupeKey: "n-1", timeout: "PT10M" } },
    ],
    edges: [
      { from: "heavy", to: "quick" },
      { from: "quick", to: "notify" },
    ],
  };
  const p = await prepareOk(graph, { nodeTimeout: "PT2H" });
  const byJobType = (jt: string) =>
    Object.values(p.nodeInputs).find((v) => (v as { jobType?: string }).jobType === jt) as { timeout: string } | undefined;
  const connector = Object.values(p.nodeInputs).find((v) => (v as { target?: string }).target === "slack:post") as
    | { timeout: string }
    | undefined;

  assertEquals(byJobType("senior:feature")?.timeout, "PT4H"); // per-node override wins
  assertEquals(byJobType("senior:demo")?.timeout, "PT2H"); // sibling keeps the run-level value
  assertEquals(connector?.timeout, "PT10M"); // connector per-node override wins too
});

test("a malformed graph returns the S1 compile errors and prepares nothing", async () => {
  const r = await prepareDeliveryGraph({ nodes: [{ id: "a", kind: "agent", agent: { jobType: "j" } }], edges: [{ from: "a", to: "ghost" }] } as unknown as DeliveryGraph);
  assert(!r.ok, "a dangling edge fails to prepare");
  assert(r.errors.some((e) => e.path === "edges[0].to"), `expected a dangling-edge error, got ${JSON.stringify(r.errors)}`);
});

test("runDeliveryGraph coerces a numeric engine processInstanceKey to a string handle", async () => {
  // The engine can yield a NUMERIC key; the handle is typed `string` and downstream expects a string.
  const engine = {
    deployResources: async () => [],
    createInstance: async () => ({ processInstanceKey: 987654321 as unknown as string }),
  };
  const r = await runDeliveryGraph(engine, GRAPH);
  assert(r.ok, `expected ok:true, got ${JSON.stringify(r)}`);
  assertEquals(r.handle.processInstanceKey, "987654321");
  assertEquals(typeof r.handle.processInstanceKey, "string");
});
