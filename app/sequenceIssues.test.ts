// Tests for the `sequenceIssues` intent → canonical delivery-graph GENERATOR (epic
// nano-workforce#605, S4/#610). The core acceptance guard: the generated graph is EQUIVALENT to the
// hand-authored canonical §9.4 chain for the same inputs — same node kinds, edges, and `pr`-fact
// threading — so an agent never re-authors 13 nodes + 12 edges by hand. Also pins the input/vocabulary
// validation contract (`issues[{path,message}]`).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { compileDeliveryGraph } from "../app/deliveryGraphCompiler.ts";
import { validateDeliveryGraph } from "../app/deliveryGraph.ts";
import { buildSequenceGraph, MAX_SEQUENCE_ISSUES, MERGE_POLL } from "./sequenceIssues.ts";

type AnyGraph = { name?: string; nodes: any[]; edges: any[] };

function ok(intent: unknown): AnyGraph {
  const res = buildSequenceGraph(intent);
  assert(res.ok, `expected ok, got ${JSON.stringify(res)}`);
  return res.graph as AnyGraph;
}

/** The hand-authored canonical chain for the SAME inputs — what §9.4 says an agent would build by
 * hand. The generator must produce a structurally-equivalent graph. */
function handAuthored(behind: string | null, issues: string[]): AnyGraph {
  const nodes: any[] = [];
  const edges: any[] = [];
  if (behind) {
    nodes.push({
      id: "gate-epic",
      kind: "wait",
      wait: { kind: "epic", target: behind, match: { epicState: "merged" }, poll: { ...MERGE_POLL }, onTimeout: "escalate" },
      emits: [{ name: "prCount", type: "number" }],
    });
  }
  issues.forEach((issue, i) => {
    const n = i + 1;
    nodes.push({
      id: `open-${n}`,
      kind: "agent",
      agent: { jobType: "senior:feature", prompt: `Implement ${issue} and open a PR.` },
      emits: [{ name: "pr", type: "pr" }],
    });
    nodes.push({ id: `land-${n}`, kind: "connector", connector: { target: "converge-merge", payload: { pr: `open-${n}.pr` } } });
    nodes.push({
      id: `merged-${n}`,
      kind: "wait",
      wait: { kind: "pr", target: `open-${n}.pr`, match: { prState: "merged" }, poll: { ...MERGE_POLL }, onTimeout: "escalate" },
    });
    edges.push({ from: `open-${n}.pr`, to: `land-${n}` });
    edges.push({ from: `open-${n}.pr`, to: `merged-${n}` });
    if (i === 0) {
      if (behind) edges.push({ from: "gate-epic", to: `open-${n}` });
    } else {
      edges.push({ from: `merged-${i}`, to: `open-${n}` });
    }
  });
  return { nodes, edges };
}

/** Compare two graphs by their SEMANTIC content — node set (by id) and edge set — order-insensitive. */
function assertEquivalent(actual: AnyGraph, expected: AnyGraph): void {
  const byId = (g: AnyGraph) => new Map(g.nodes.map((n) => [n.id, n]));
  const a = byId(actual);
  const e = byId(expected);
  assertEquals([...a.keys()].sort(), [...e.keys()].sort(), "same node ids");
  for (const [id, node] of e) assertEquals(a.get(id), node, `node ${id} matches canonical`);
  const edgeKey = (x: any) => JSON.stringify([x.from, x.to, x.when ?? null, x.equals ?? null, x.default ?? null]);
  assertEquals(actual.edges.map(edgeKey).sort(), expected.edges.map(edgeKey).sort(), "same edge set");
}

test("sequenceIssues: four issues behind a gate → the exact 13-node / 12-edge canonical chain", () => {
  const behind = "acme/repo#100";
  const issues = ["acme/repo#1", "acme/repo#2", "acme/repo#3", "acme/repo#4"];
  const graph = ok({ behind, issues });
  // The evidence-session shape: 1 gate + 3 nodes/issue = 13 nodes; 8 fact edges + 1 gate edge + 3
  // sequence edges = 12 edges.
  assertEquals(graph.nodes.length, 13);
  assertEquals(graph.edges.length, 12);
  assertEquivalent(graph, handAuthored(behind, issues));
});

test("sequenceIssues: without `behind`, no leading epic gate and no gate edge", () => {
  const issues = ["acme/repo#1", "acme/repo#2"];
  const graph = ok({ issues });
  assertEquals(graph.nodes.length, 6);
  assertEquals(graph.edges.length, 5); // 2 fact edges/issue (4) + 1 sequence edge
  assert(!graph.nodes.some((n) => n.id === "gate-epic"), "no epic gate without `behind`");
  assertEquivalent(graph, handAuthored(null, issues));
});

test("sequenceIssues: each issue emits agent(senior:feature,emits pr) → connector(converge-merge) → wait[pr,merged]", () => {
  const graph = ok({ issues: ["acme/repo#7"] });
  const open = graph.nodes.find((n) => n.id === "open-1");
  const land = graph.nodes.find((n) => n.id === "land-1");
  const merged = graph.nodes.find((n) => n.id === "merged-1");
  assertEquals(open.kind, "agent");
  assertEquals(open.agent.jobType, "senior:feature");
  assertEquals(open.emits, [{ name: "pr", type: "pr" }]);
  assertEquals(land.kind, "connector");
  assertEquals(land.connector.target, "converge-merge");
  assertEquals(land.connector.payload, { pr: "open-1.pr" });
  assertEquals(merged.kind, "wait");
  assertEquals(merged.wait.kind, "pr");
  assertEquals(merged.wait.target, "open-1.pr");
  assertEquals(merged.wait.match, { prState: "merged" });
  // The pr fact is threaded to BOTH consumers by fact-qualified edges (§9.4).
  assert(graph.edges.some((e) => e.from === "open-1.pr" && e.to === "land-1"));
  assert(graph.edges.some((e) => e.from === "open-1.pr" && e.to === "merged-1"));
});

test("sequenceIssues: merge/epic gates carry a realistic poll budget (not the 30-min default trap)", () => {
  const graph = ok({ behind: "acme/repo#9", issues: ["acme/repo#1"] });
  const gate = graph.nodes.find((n) => n.id === "gate-epic");
  const merged = graph.nodes.find((n) => n.id === "merged-1");
  assertEquals(gate.wait.poll, { everyMs: 300_000, timeoutMs: 259_200_000 });
  assertEquals(merged.wait.poll, { everyMs: 300_000, timeoutMs: 259_200_000 });
  assert(merged.wait.poll.timeoutMs > 30 * 60 * 1000, "budget must exceed the 30-minute default");
});

test("sequenceIssues: the generated graph passes validateDeliveryGraph AND compiles", async () => {
  const graph = ok({ behind: "acme/repo#100", issues: ["acme/repo#1", "acme/repo#2", "acme/repo#3", "acme/repo#4"] });
  assertEquals(validateDeliveryGraph(graph), []);
  const compiled = await compileDeliveryGraph(graph);
  assert(compiled.ok, `expected the generated graph to compile, got ${JSON.stringify(compiled)}`);
});

test("sequenceIssues: an issue URL is accepted and normalised to owner/repo#N", () => {
  const graph = ok({ issues: ["https://github.com/acme/repo/issues/42"] });
  const open = graph.nodes.find((n) => n.id === "open-1");
  assertEquals(open.agent.prompt, "Implement acme/repo#42 and open a PR.");
});

// ── Validation: the uniform issues[{path,message}] contract ─────────────────────────────────────
function rejects(intent: unknown): Array<{ path: string; message: string }> {
  const res = buildSequenceGraph(intent);
  assert(!res.ok, `expected rejection, got ${JSON.stringify(res)}`);
  assert(Array.isArray(res.issues) && res.issues.length > 0, "issues[] must be non-empty");
  for (const iss of res.issues) {
    assert(typeof iss.path === "string" && typeof iss.message === "string", `bad issue ${JSON.stringify(iss)}`);
  }
  return res.issues;
}

test("sequenceIssues: empty issues → rejected with issues[{path,message}]", () => {
  const issues = rejects({ issues: [] });
  assert(issues.some((i) => i.path === "issues"));
});

test("sequenceIssues: missing issues → rejected", () => {
  const issues = rejects({});
  assert(issues.some((i) => i.path === "issues"));
});

test("sequenceIssues: an unparseable issue ref → rejected at the offending index", () => {
  const issues = rejects({ issues: ["acme/repo#1", "not-an-issue"] });
  assert(issues.some((i) => i.path === "issues[1]"), `expected issues[1] path, got ${JSON.stringify(issues)}`);
});

test("sequenceIssues: an unparseable `behind` ref → rejected at behind", () => {
  const issues = rejects({ behind: "nope", issues: ["acme/repo#1"] });
  assert(issues.some((i) => i.path === "behind"));
});

test("sequenceIssues: an empty-string `behind` → rejected at behind (not silently ungated)", () => {
  const issues = rejects({ behind: "", issues: ["acme/repo#1"] });
  assert(issues.some((i) => i.path === "behind"), `expected behind path, got ${JSON.stringify(issues)}`);
});

test("sequenceIssues: a non-positive issue number (`#0`) → rejected at the offending index", () => {
  const issues = rejects({ issues: ["acme/repo#0"] });
  assert(issues.some((i) => i.path === "issues[0]"), `expected issues[0] path, got ${JSON.stringify(issues)}`);
});

test("sequenceIssues: an unsafe-integer issue number → rejected at the offending index", () => {
  const issues = rejects({ issues: ["acme/repo#1", "acme/repo#99999999999999999999"] });
  assert(issues.some((i) => i.path === "issues[1]"), `expected issues[1] path, got ${JSON.stringify(issues)}`);
});

test("sequenceIssues: a non-positive `behind` number (`#0`) → rejected at behind", () => {
  const issues = rejects({ behind: "acme/repo#0", issues: ["acme/repo#1"] });
  assert(issues.some((i) => i.path === "behind"), `expected behind path, got ${JSON.stringify(issues)}`);
});

test("sequenceIssues: more than the max issues → rejected", () => {
  const many = Array.from({ length: MAX_SEQUENCE_ISSUES + 1 }, (_, i) => `acme/repo#${i + 1}`);
  const issues = rejects({ issues: many });
  assert(issues.some((i) => i.path === "issues"));
});

// ── Interleaved gates (issue #740) ──────────────────────────────────────────────────────────────

test("sequenceIssues: the issue's example — an npm gate between two issues generates a wait[npm] node gating the agent on prior merge AND publish", () => {
  const graph = ok({
    issues: [
      "nanobpm/nano-ide#557",
      { gate: { kind: "npm", target: "@nanobpm/agentic@0.13.0" }, issue: "jwulf/c8ctl-plugin-nano#186" },
      "nanobpm/nano-workforce#738",
    ],
  });
  // 3 issues × 3 canonical nodes + 1 interleaved gate node = 10.
  assertEquals(graph.nodes.length, 10);
  const gate = graph.nodes.find((n) => n.id === "gate-2");
  assert(gate, "the interleaved gate node must exist");
  assertEquals(gate.kind, "wait");
  assertEquals(gate.wait.kind, "npm");
  assertEquals(gate.wait.target, "@nanobpm/agentic@0.13.0");
  // The gate carries the bounded default budget (not the 30-min trap).
  assertEquals(gate.wait.poll, { everyMs: 300_000, timeoutMs: 259_200_000 });
  assertEquals(gate.wait.onTimeout, "escalate");
  // Gated on the prior merge: merged-1 → gate-2. Gated on the publish → the agent waits on the gate:
  // gate-2 → open-2. Together the agent (open-2) starts only after issue-1 merged AND the npm publish.
  assert(graph.edges.some((e) => e.from === "merged-1" && e.to === "gate-2"), "gate waits on the prior merge");
  assert(graph.edges.some((e) => e.from === "gate-2" && e.to === "open-2"), "the agent waits on the gate");
  // No direct merged-1 → open-2 edge — the gate is spliced in between.
  assert(!graph.edges.some((e) => e.from === "merged-1" && e.to === "open-2"), "the gate replaces the direct sequence edge");
  // The third (ungated) issue still sequences directly off the second's merge.
  assert(graph.edges.some((e) => e.from === "merged-2" && e.to === "open-3"), "an ungated issue keeps the direct sequence edge");
});

test("sequenceIssues: a gate on the FIRST issue behind an epic gate chains gate-epic → gate-1 → open-1", () => {
  const graph = ok({
    behind: "acme/repo#100",
    issues: [{ gate: { kind: "github-check", target: "acme/repo@main" }, issue: "acme/repo#1" }],
  });
  assert(graph.nodes.some((n) => n.id === "gate-epic"), "the leading epic gate exists");
  assert(graph.nodes.some((n) => n.id === "gate-1"), "the interleaved first-issue gate exists");
  assert(graph.edges.some((e) => e.from === "gate-epic" && e.to === "gate-1"), "epic gate → interleaved gate");
  assert(graph.edges.some((e) => e.from === "gate-1" && e.to === "open-1"), "interleaved gate → agent");
  assert(!graph.edges.some((e) => e.from === "gate-epic" && e.to === "open-1"), "the interleaved gate is spliced before the agent");
});

test("sequenceIssues: a gated first issue with NO behind gate starts the gate immediately (no predecessor edge)", () => {
  const graph = ok({ issues: [{ gate: { kind: "npm", target: "pkg@1.0.0" }, issue: "acme/repo#1" }] });
  // No inbound edge to gate-1 (nothing precedes it); the agent still waits on the gate.
  assert(!graph.edges.some((e) => e.to === "gate-1"), "an ungated-first gate has no predecessor edge");
  assert(graph.edges.some((e) => e.from === "gate-1" && e.to === "open-1"), "the agent waits on the gate");
});

test("sequenceIssues: a gate's `kind`/`target` are trimmed before validation AND persistence (no whitespace-poisoned probe)", () => {
  // Surrounding whitespace must neither trip a confusing "unknown kind" rejection nor survive into
  // the generated `wait` node, where a stray trailing space silently probes the wrong target.
  const graph = ok({ issues: [{ gate: { kind: " npm ", target: " pkg@1.0.0 " }, issue: "acme/repo#1" }] });
  const gate = graph.nodes.find((n) => n.id === "gate-1");
  assert(gate, "the interleaved gate node must exist");
  assertEquals(gate.wait.kind, "npm");
  assertEquals(gate.wait.target, "pkg@1.0.0");
});

test("sequenceIssues: an object entry accepts optional gate fields (match, poll, onTimeout, credentialEnv)", () => {
  const graph = ok({
    issues: [
      {
        gate: {
          kind: "http",
          target: "https://example.test/ready",
          match: { status: 200 },
          poll: { everyMs: 1000, timeoutMs: 60000 },
          onTimeout: "continue",
          credentialEnv: "MY_TOKEN",
        },
        issue: "acme/repo#1",
      },
    ],
  });
  const gate = graph.nodes.find((n) => n.id === "gate-1");
  assertEquals(gate.wait.match, { status: 200 });
  assertEquals(gate.wait.poll, { everyMs: 1000, timeoutMs: 60000 });
  assertEquals(gate.wait.onTimeout, "continue");
  assertEquals(gate.wait.credentialEnv, "MY_TOKEN");
});

test("sequenceIssues: a bare-string entry is byte-for-byte identical to the object form without a gate", () => {
  const bare = ok({ issues: ["acme/repo#1", "acme/repo#2"] });
  const objs = ok({ issues: [{ issue: "acme/repo#1" }, { issue: "acme/repo#2" }] });
  assertEquals(objs.nodes, bare.nodes);
  assertEquals(objs.edges, bare.edges);
});

test("sequenceIssues: a graph with an interleaved gate passes validateDeliveryGraph AND compiles", async () => {
  const graph = ok({
    issues: [
      "acme/repo#1",
      { gate: { kind: "npm", target: "@scope/pkg@2.0.0" }, issue: "acme/repo#2" },
    ],
  });
  assertEquals(validateDeliveryGraph(graph), []);
  const compiled = await compileDeliveryGraph(graph);
  assert(compiled.ok, `expected the gated graph to compile, got ${JSON.stringify(compiled)}`);
});

test("sequenceIssues: an unknown gate kind → rejected at issues[i].gate.kind", () => {
  const issues = rejects({ issues: [{ gate: { kind: "no-such-probe", target: "x" }, issue: "acme/repo#1" }] });
  assert(issues.some((i) => i.path === "issues[0].gate.kind"), `expected issues[0].gate.kind, got ${JSON.stringify(issues)}`);
});

test("sequenceIssues: a gate missing its target → rejected at issues[i].gate.target", () => {
  const issues = rejects({ issues: [{ gate: { kind: "npm" }, issue: "acme/repo#1" }] });
  assert(issues.some((i) => i.path === "issues[0].gate.target"), `expected issues[0].gate.target, got ${JSON.stringify(issues)}`);
});

test("sequenceIssues: a gate with onTimeout:fail → rejected at issues[i].gate.onTimeout", () => {
  const issues = rejects({ issues: [{ gate: { kind: "npm", target: "pkg@1", onTimeout: "fail" }, issue: "acme/repo#1" }] });
  assert(issues.some((i) => i.path === "issues[0].gate.onTimeout"), `expected issues[0].gate.onTimeout, got ${JSON.stringify(issues)}`);
});

test("sequenceIssues: an object entry missing `issue` → rejected at issues[i].issue", () => {
  const issues = rejects({ issues: [{ gate: { kind: "npm", target: "pkg@1" } }] });
  assert(issues.some((i) => i.path === "issues[0].issue"), `expected issues[0].issue, got ${JSON.stringify(issues)}`);
});

test("sequenceIssues: a fully-gated max-length sequence behind an epic gate exceeds the node ceiling → rejected", () => {
  const many = Array.from({ length: MAX_SEQUENCE_ISSUES }, (_, i) => ({
    gate: { kind: "npm", target: `pkg@${i + 1}` },
    issue: `acme/repo#${i + 1}`,
  }));
  // 64 × 4 nodes + 1 epic gate = 257 > 256.
  const issues = rejects({ behind: "acme/repo#999", issues: many });
  assert(issues.some((i) => i.path === "issues" && /too many nodes/.test(i.message)), `expected a node-ceiling rejection, got ${JSON.stringify(issues)}`);
});
