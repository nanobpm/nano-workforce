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

test("sequenceIssues: more than the max issues → rejected", () => {
  const many = Array.from({ length: MAX_SEQUENCE_ISSUES + 1 }, (_, i) => `acme/repo#${i + 1}`);
  const issues = rejects({ issues: many });
  assert(issues.some((i) => i.path === "issues"));
});
