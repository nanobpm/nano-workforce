// Unit coverage for the deterministic delivery-graph compiler `compileDeliveryGraph` (ADR 0005,
// slice S1). The compiler is the TRUSTED inner loop: it validates (via S0's `validateDeliveryGraph`),
// compiles to a native BPMN artifact, and renders a preview — with ZERO side effects. These tests
// exercise, directly and with no HTTP:
//   • the happy path (a fully-worked release runbook → ok:true with every preview field),
//   • DETERMINISM (same JSON → byte-identical bpmn/diagram/resolved — the core trust property),
//   • rejection of every malformed class (unknown-kind / dangling / bad-from / cycle) as ok:false
//     with path-qualified errors forwarded verbatim from the validator,
//   • the trust bound — every node inlines an embedded subProcess whose inner body delegates to an
//     allowlisted engine-native worker (serviceTask `type`) or user task (human); no scriptTask/
//     callActivity ever appears (call activities are a no-op on the pinned WASM engine, ADR 0005 S4),
//   • fan-in / fan-out / multi-root / multi-leaf → explicit parallel gateways,
//   • humanNodes[] and sideEffects[] extraction.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { compileDeliveryGraph } from "./deliveryGraphCompiler.ts";

/** Compile and assert success, returning the narrowed ok-result. */
async function compileOk(graph: unknown) {
  const r = await compileDeliveryGraph(graph);
  assert(r.ok, `expected ok:true, got ${JSON.stringify(r)}`);
  return r;
}

/** Compile and assert failure, returning the errors. */
async function compileFail(graph: unknown) {
  const r = await compileDeliveryGraph(graph);
  assert(!r.ok, `expected ok:false, got ${JSON.stringify(r)}`);
  return r.errors;
}

// The ADR's motivating case: an agent merges PR #B, a `pr` wait node watches it merge and emits
// `mergedSha`, a human does the manual OTP publish emitting `resolvedArtifact`, and a connector
// consumes the published artifact.
const RELEASE_RUNBOOK = {
  name: "release runbook",
  nodes: [
    { id: "open-b", kind: "agent", agent: { jobType: "senior:feature", prompt: "un-draft + merge #B" } },
    {
      id: "watch-b",
      kind: "wait",
      wait: { kind: "pr", target: "owner/repo#42", match: { prState: "merged" } },
      emits: [{ name: "mergedSha", type: "string" }],
    },
    {
      id: "publish",
      kind: "human",
      human: { prompt: "run the manual OTP publish", formKey: "publish-form" },
      emits: [{ name: "resolvedArtifact", type: "artifact" }],
    },
    { id: "consume", kind: "connector", connector: { target: "npm:install", dedupeKey: "consume-1" } },
  ],
  edges: [
    { from: "open-b", to: "watch-b" },
    { from: "watch-b.mergedSha", to: "publish" },
    { from: "publish.resolvedArtifact", to: "consume" },
  ],
};

test("happy path: a well-formed graph compiles to a full preview with no side effects", async () => {
  const r = await compileOk(RELEASE_RUNBOOK);
  assertEquals(r.ok, true);
  assert(r.bpmn.includes("<bpmn:process id=\"delivery-graph\""), "bpmn carries the compiled process");
  assert(r.diagram.startsWith("flowchart TD"), "diagram is a mermaid flowchart");
  assertEquals(r.resolved.name, "release runbook");
  assertEquals(r.resolved.nodes.length, 4);
  assertEquals(r.resolved.edges.length, 3);
  assertEquals(r.humanNodes.length, 1);
  // agent + connector are side-effecting; wait + human are not.
  assertEquals(r.sideEffects.length, 2);
});

test("determinism: the same JSON always yields byte-identical bpmn/diagram/resolved", async () => {
  const a = await compileOk(RELEASE_RUNBOOK);
  const b = await compileOk(RELEASE_RUNBOOK);
  assertEquals(a.bpmn, b.bpmn);
  assertEquals(a.diagram, b.diagram);
  assertEquals(JSON.stringify(a.resolved), JSON.stringify(b.resolved));
  // Node ORDER in the input must not change the artifact (nodes are sorted by id).
  const shuffled = { ...RELEASE_RUNBOOK, nodes: [...RELEASE_RUNBOOK.nodes].reverse() };
  const c = await compileOk(shuffled);
  assertEquals(c.bpmn, a.bpmn);
  assertEquals(c.diagram, a.diagram);
});

test("trust bound: every node inlines an embedded subProcess delegating to an allowlisted body — no other activity type", async () => {
  const r = await compileOk(RELEASE_RUNBOOK);
  // Each of the 4 nodes compiles to an EMBEDDED subProcess; wait adds one nested retry-loop subProcess (call activities are a no-op on the pinned
  // WASM engine, so delegation is an inlined subProcess sharing the parent scope — never a callActivity).
  assertEquals((r.bpmn.match(/<bpmn:callActivity/g) ?? []).length, 0);
  assertEquals((r.bpmn.match(/<bpmn:subProcess /g) ?? []).length, 5);
  assert(!r.bpmn.includes("<bpmn:scriptTask"), "no script task is ever emitted");
  // Each node's inner body delegates to an allowlisted engine-native body: a `serviceTask` typed to a
  // worker (agent → its `senior:*` job; wait → `pr.readiness-probe`; connector → `pr.delivery-connector`)
  // or a `userTask` (human). Collect the service delegation targets.
  const types = new Set([...r.bpmn.matchAll(/<zeebe:taskDefinition type="([^"]+)"/g)].map((m) => m[1]));
  assert(types.has("senior:feature"), "agent delegates to its named job type");
  assert(types.has("pr.readiness-probe"), "wait delegates to the readiness-probe gate");
  assert(types.has("pr.delivery-connector"), "connector delegates to the connector worker");
  // The human node inlines the S3 user-task body under the per-node convention id, and the bounded
  // service nodes inline a human-completable escalation userTask under the same convention.
  assert(/<bpmn:userTask id="delivery-human-task__n\d+"/.test(r.bpmn), "human node inlines its per-node user task");
  assert(/<bpmn:userTask id="delivery-human-task__n\d+__esc"/.test(r.bpmn), "a bounded node inlines an escalation user task");
});

test("late-binding: a fact-qualified edge threads a boundFacts input into the consumer subProcess", async () => {
  const r = await compileOk(RELEASE_RUNBOOK);
  // `publish.resolvedArtifact -> consume`: the connector subProcess receives the human's emitted fact as
  // a boundFacts list entry, read from the flat `<producerElement>_<fact>` variable the producer publishes.
  // FEEL string literals must use single-quote XML-attribute delimiters (the engine deploy path drops
  // `&quot;`-encoded quotes silently), so the boundFacts source is single-quoted with literal quotes.
  assert(r.bpmn.includes("target=\"boundFacts\""), "the consumer receives a boundFacts input");
  const boundInput = /<zeebe:input source='=\[\{from: "publish"[^']*\}\]' target="boundFacts"/.test(r.bpmn);
  assert(boundInput, `boundFacts is a single-quoted FEEL list literal, got: ${r.bpmn.match(/source='[^']*' target="boundFacts"/)?.[0] ?? r.bpmn.match(/source="[^"]*" target="boundFacts"/)?.[0]}`);
});

test("rejects unknown kind (by construction) with a path-qualified error, nothing compiled", async () => {
  const errors = await compileFail({
    nodes: [{ id: "x", kind: "deploy", deploy: { target: "prod" } }],
  });
  const e = errors.find((err) => err.path === "nodes[0].kind");
  assert(e !== undefined, `expected a nodes[0].kind error, got ${JSON.stringify(errors)}`);
  assert(e.message.length > 0);
});

test("rejects a dependency cycle with a path-qualified error", async () => {
  const errors = await compileFail({
    nodes: [
      { id: "a", kind: "agent", agent: { jobType: "j" } },
      { id: "b", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ],
  });
  assert(errors.some((e) => /cycle/i.test(e.message)), `expected a cycle error, got ${JSON.stringify(errors)}`);
});

test("rejects a dangling edge and a bad fact reference, each path-qualified", async () => {
  const dangling = await compileFail({
    nodes: [{ id: "a", kind: "agent", agent: { jobType: "j" } }],
    edges: [{ from: "a", to: "ghost" }],
  });
  assert(dangling.some((e) => e.path === "edges[0].to"));

  const badFrom = await compileFail({
    nodes: [
      { id: "a", kind: "wait", wait: { kind: "http", target: "u" }, emits: [{ name: "x", type: "string" }] },
      { id: "b", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [{ from: "a.nope", to: "b" }],
  });
  assert(badFrom.some((e) => e.path === "edges[0].from"));
});

test("fan-in: a node with two producers gets a parallel JOIN gateway", async () => {
  const r = await compileOk({
    nodes: [
      { id: "a", kind: "agent", agent: { jobType: "j" } },
      { id: "b", kind: "agent", agent: { jobType: "j" } },
      { id: "c", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [
      { from: "a", to: "c" },
      { from: "b", to: "c" },
    ],
  });
  assert(r.bpmn.includes("<bpmn:parallelGateway"), "a join gateway is emitted");
  const cNode = r.resolved.nodes.find((n) => n.id === "c");
  assertEquals(cNode?.dependsOn, ["a", "b"]);
});

test("fan-out: a node with two consumers gets a parallel FORK gateway", async () => {
  const r = await compileOk({
    nodes: [
      { id: "a", kind: "agent", agent: { jobType: "j" } },
      { id: "b", kind: "agent", agent: { jobType: "j" } },
      { id: "c", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "a", to: "c" },
    ],
  });
  assert(r.bpmn.includes('name="fan out of a"'), "a fork gateway for node a is emitted");
});

test("multiple roots fork from Start and multiple leaves join into End", async () => {
  const r = await compileOk({
    nodes: [
      { id: "r1", kind: "agent", agent: { jobType: "j" } },
      { id: "r2", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [],
  });
  assert(r.bpmn.includes('id="gwf_start"'), "a start fork gateway for multiple roots");
  assert(r.bpmn.includes('id="gwj_end"'), "an end join gateway for multiple leaves");
});

test("humanNodes: extracts prompt/formKey/emits; a click-done node emits nothing", async () => {
  const r = await compileOk({
    nodes: [
      {
        id: "publish",
        kind: "human",
        human: { prompt: "OTP publish", formKey: "f1" },
        emits: [{ name: "resolvedArtifact", type: "artifact" }],
      },
      { id: "ack", kind: "human" },
    ],
    edges: [{ from: "publish", to: "ack" }],
  });
  const publish = r.humanNodes.find((h) => h.nodeId === "publish");
  assertEquals(publish?.prompt, "OTP publish");
  assertEquals(publish?.formKey, "f1");
  assertEquals(publish?.emits.length, 1);
  const ack = r.humanNodes.find((h) => h.nodeId === "ack");
  assertEquals(ack?.emits.length, 0);
  assertEquals(ack?.prompt, undefined);
});

test("sideEffects: agent + connector only; connector carries its dedupeKey", async () => {
  const r = await compileOk(RELEASE_RUNBOOK);
  const agent = r.sideEffects.find((s) => s.nodeId === "open-b");
  assertEquals(agent?.kind, "agent");
  assert(agent?.description.includes("senior:feature"));
  const connector = r.sideEffects.find((s) => s.nodeId === "consume");
  assertEquals(connector?.kind, "connector");
  assertEquals(connector?.dedupeKey, "consume-1");
  // The wait + human nodes are NOT side effects.
  assert(!r.sideEffects.some((s) => s.nodeId === "watch-b"));
  assert(!r.sideEffects.some((s) => s.nodeId === "publish"));
});

test("resolved edges carry the resolved fromNode and the referenced fact", async () => {
  const r = await compileOk(RELEASE_RUNBOOK);
  const factEdge = r.resolved.edges.find((e) => e.from === "watch-b.mergedSha");
  assertEquals(factEdge?.fromNode, "watch-b");
  assertEquals(factEdge?.fromFact, "mergedSha");
  const plainEdge = r.resolved.edges.find((e) => e.from === "open-b");
  assertEquals(plainEdge?.fromNode, "open-b");
  assertEquals(plainEdge?.fromFact, undefined);
});

test("BPMN is structurally coherent: one process start, one process end, every flow endpoint declared", async () => {
  const r = await compileOk(RELEASE_RUNBOOK);
  // The TOP-LEVEL process has exactly one Start and one End (each inlined subProcess has its OWN
  // start/end events, so a raw `<bpmn:startEvent>` count is not the process boundary — the fixed ids are).
  assertEquals((r.bpmn.match(/ id="Start"/g) ?? []).length, 1);
  assertEquals((r.bpmn.match(/ id="End"/g) ?? []).length, 1);
  // Every sequenceFlow source/target id is declared as an element id in the document.
  const declaredIds = new Set([...r.bpmn.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
  for (const m of r.bpmn.matchAll(/sourceRef="([^"]+)" targetRef="([^"]+)"/g)) {
    assert(declaredIds.has(m[1]), `sourceRef ${m[1]} is declared`);
    assert(declaredIds.has(m[2]), `targetRef ${m[2]} is declared`);
  }
});

test("duplicate fact-qualified edges between the same node pair collapse to ONE sequence flow", async () => {
  // `src` emits two facts, both feeding `b` (`src.x -> b` and `src.y -> b`). Adjacency is de-duped by
  // node id, so no fork/join gateway is inserted — the producer wires straight to the consumer. The
  // compiler must therefore collapse the two edges into a SINGLE sequenceFlow so `b` is not scheduled
  // twice (multiple outgoing flows without a diverging gateway is invalid/double-executing BPMN).
  const r = await compileOk({
    nodes: [
      {
        id: "src",
        kind: "wait",
        wait: { kind: "pr", target: "owner/repo#1", match: { prState: "merged" } },
        emits: [
          { name: "x", type: "string" },
          { name: "y", type: "string" },
        ],
      },
      { id: "b", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [
      { from: "src.x", to: "b" },
      { from: "src.y", to: "b" },
    ],
  });
  // src ("src") sorts after b? No: "b" < "src" → b is n0, src is n1. src has one consumer (b, deduped)
  // so no fork; b has one producer (src, deduped) so no join. The single collapsed edge is src → b.
  const flows = [...r.bpmn.matchAll(/sourceRef="([^"]+)" targetRef="([^"]+)"/g)];
  const srcToB = flows.filter(([, s, t]) => s === "n1" && t === "n0");
  assertEquals(srcToB.length, 1, `expected exactly one src→b flow, got ${JSON.stringify(srcToB.map((m) => m[0]))}`);
  // No parallel gateway is introduced for this de-duplicated pair.
  assert(!r.bpmn.includes("<bpmn:parallelGateway"), "no gateway for a single de-duplicated producer/consumer pair");
});

test("a non-object / empty body is a clean ok:false, never a throw", async () => {
  assert(!(await compileDeliveryGraph(undefined)).ok);
  assert(!(await compileDeliveryGraph(null)).ok);
  assert(!(await compileDeliveryGraph({})).ok);
  assert(!(await compileDeliveryGraph({ nodes: [] })).ok);
});

test("DI (#440): the compiled bpmn carries an auto-laid-out bpmndi:BPMNDiagram — a shape per element, an edge per flow", async () => {
  // The delivery-graph compiler is the ONE BPMN generated at runtime; every AUTHORED process gets DI
  // from `npm run layout` (`layoutBpmn`), and before #440 this generated one skipped that pass and
  // shipped DI-less — a compiled/running graph rendered positionless in the process explorer. The
  // compiler now runs the SAME `layoutBpmn` autolayout, so the preview `bpmn` (what actually deploys)
  // carries diagram interchange. This RED/GREEN guard fails on the old DI-less output.
  const r = await compileOk(RELEASE_RUNBOOK);
  assert(r.bpmn.includes("<bpmndi:BPMNDiagram"), "compiled bpmn carries a bpmndi:BPMNDiagram");
  assert(r.bpmn.includes("<bpmndi:BPMNPlane"), "the diagram has a plane");
  // The top-level plane references the compiled process, so the process explorer can render it.
  assert(r.bpmn.includes('bpmnElement="delivery-graph"'), "the top-level plane binds to the process id");
  // A shape per BPMN element and an edge per sequence flow — the same "N shapes + M edges" accounting
  // `scripts/layout-bpmn.ts` reports. Every declared sequenceFlow gets a BPMNEdge.
  const shapes = (r.bpmn.match(/<bpmndi:BPMNShape\b/g) ?? []).length;
  const edges = (r.bpmn.match(/<bpmndi:BPMNEdge\b/g) ?? []).length;
  const flows = (r.bpmn.match(/<bpmn:sequenceFlow\b/g) ?? []).length;
  assert(shapes > 0, "at least one BPMNShape is drawn");
  assertEquals(edges, flows, "every sequence flow gets exactly one BPMNEdge");
});

test("DI (#440) is deterministic: identical JSON yields byte-identical laid-out bpmn", async () => {
  // `layoutBpmn` (bpmn-auto-layout) is deterministic given identical semantic input, so adding the
  // diagram must not break the compiler's "same JSON → byte-identical XML" trust property.
  const a = await compileOk(RELEASE_RUNBOOK);
  const b = await compileOk(RELEASE_RUNBOOK);
  assertEquals(a.bpmn, b.bpmn);
});
