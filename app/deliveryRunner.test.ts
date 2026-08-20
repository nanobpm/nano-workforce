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

function prepareOk(graph: DeliveryGraph, options = {}) {
  const r = prepareDeliveryGraph(graph, options);
  assert(r.ok, `expected ok:true, got ${JSON.stringify(r)}`);
  return r.prepared;
}

test("content-addressed id: deterministic for the same graph, content-sensitive across graphs", () => {
  const a = prepareOk(GRAPH);
  const b = prepareOk(GRAPH);
  assert(/^delivery-graph-[0-9a-f]{12}$/.test(a.processDefinitionId), `id is content-addressed, got ${a.processDefinitionId}`);
  assertEquals(a.processDefinitionId, b.processDefinitionId);

  // A structurally different graph gets a DIFFERENT id (no collision / no accidental redeploy-as-same).
  const other = prepareOk({ ...GRAPH, nodes: [...GRAPH.nodes, { id: "extra", kind: "agent", agent: { jobType: "senior:feature" } }], edges: [...GRAPH.edges, { from: "consume", to: "extra" }] });
  assert(other.processDefinitionId !== a.processDefinitionId, "a different graph yields a different id");
});

test("the deployable BPMN rewrites the base process id to the content-addressed deploy id", () => {
  const p = prepareOk(GRAPH);
  assert(p.bpmn.includes(`<bpmn:process id="${p.processDefinitionId}"`), "process id is the content-addressed id");
  assert(!p.bpmn.includes('<bpmn:process id="delivery-graph"'), "the base id no longer appears as the process id");
});

test("nodeInputs seeds the exact per-kind fields each node's subProcess ioMapping reads", () => {
  const p = prepareOk(GRAPH, { nodeTimeout: "PT10M", probeTimeout: "PT20M", escalationSlaTimeout: "PT2H", escalationAssignee: "alice", runKey: "run-7" });
  // Element ids are positional by sorted node id: consume, open-b, publish, watch-b → n0..n3.
  const inputs = p.nodeInputs;
  const byField = (pred: (v: Record<string, unknown>) => boolean) => Object.values(inputs).find((v) => pred(v as Record<string, unknown>)) as Record<string, unknown> | undefined;

  const agent = byField((v) => v.jobType === "senior:feature");
  assertEquals(agent, { jobType: "senior:feature", appendPrompt: "un-draft + merge #B", timeout: "PT10M" });

  const wait = byField((v) => "gateKey" in v);
  assertEquals(wait?.gateKey, "run-7:n3");
  assertEquals(wait?.probeTimeout, "PT20M");
  assert(wait?.probe && typeof wait.probe === "object", "the wait node carries its ReadinessProbe descriptor");

  const human = byField((v) => "escalationSlaTimeout" in v);
  assertEquals(human, { escalationSlaTimeout: "PT2H", escalationAssignee: "alice" });

  const connector = byField((v) => v.target === "npm:install");
  assertEquals(connector, { target: "npm:install", dedupeKey: "consume-1", payload: null, timeout: "PT10M" });
});

test("wait gateKeys default to a fresh per-run token so concurrent runs of one graph never cross-correlate", () => {
  const gateKeyOf = (p: ReturnType<typeof prepareOk>) =>
    (Object.values(p.nodeInputs).find((v) => "gateKey" in v) as { gateKey?: string } | undefined)?.gateKey;

  const a = prepareOk(GRAPH);
  const b = prepareOk(GRAPH);
  assert(gateKeyOf(a) && gateKeyOf(b), "each run seeds a wait gateKey");
  assert(gateKeyOf(a) !== gateKeyOf(b), "two runs of the same graph get DISTINCT default gate scopes");
  // The gate key must NOT be derived from the (shared) content digest — that is the bug this guards.
  assert(!gateKeyOf(a)?.startsWith(a.processDefinitionId.slice(-12)), "default gateKey is not the graph digest");
  // The deployable definition (id + bpmn) stays deterministic regardless of the per-run gate scope.
  assertEquals(a.processDefinitionId, b.processDefinitionId);
  assertEquals(a.bpmn, b.bpmn);

  // An explicit runKey is honoured verbatim (reproducible seed).
  const seeded = prepareOk(GRAPH, { runKey: "run-7" });
  assertEquals(gateKeyOf(seeded), "run-7:n3");
});

test("a malformed graph returns the S1 compile errors and prepares nothing", () => {
  const r = prepareDeliveryGraph({ nodes: [{ id: "a", kind: "agent", agent: { jobType: "j" } }], edges: [{ from: "a", to: "ghost" }] } as unknown as DeliveryGraph);
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
