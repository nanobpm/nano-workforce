// Tests for the `sequenceIssues` intent → canonical delivery-graph GENERATOR (epic
// nano-workforce#605, S4/#610). The core acceptance guard: the generated graph is EQUIVALENT to the
// hand-authored canonical §9.4 chain for the same inputs — same node kinds, edges, and `pr`-fact
// threading — so an agent never re-authors 13 nodes + 12 edges by hand. Also pins the input/vocabulary
// validation contract (`issues[{path,message}]`).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { compileDeliveryGraph } from "../app/deliveryGraphCompiler.ts";
import { validateDeliveryGraph } from "../app/deliveryGraph.ts";
import { AFTER_POLL, buildSequenceGraph, MAX_SEQUENCE_AFTER, MAX_SEQUENCE_ISSUES, MERGE_POLL, sequenceAgentPrompt } from "./sequenceIssues.ts";

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
      // #739: the generator stamps each agent cell with the issue's OWN repository, so a multi-repo
      // sequence provisions each cell's isolation envelope from that issue's repo.
      agent: { jobType: "senior:feature", prompt: sequenceAgentPrompt(issue), repository: issue.split("#")[0] },
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

test("sequenceIssues: each agent cell is stamped with its OWN issue's repository — a cross-repo sequence (#739)", () => {
  // Two issues in DIFFERENT repos → each `open-*` agent node declares that issue's repository, so the
  // delivery runner provisions each cell's isolation envelope from its own repo (no uniform run-level
  // repository, no `repoless`). This is the generator half of #739.
  const graph = ok({ issues: ["acme/one#1", "beta/two#2"] });
  assertEquals(graph.nodes.find((n) => n.id === "open-1").agent.repository, "acme/one");
  assertEquals(graph.nodes.find((n) => n.id === "open-2").agent.repository, "beta/two");
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
  assertEquals(open.agent.prompt, sequenceAgentPrompt("acme/repo#42"));
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

// ── issue #1056: `after[]` AND-gate, `parallel` fan-out, full-scope-acknowledging prompts ────────────

/** The hand-written graph from the #1056 evidence: N `wait[pr, merged]` gates (7-day budget) joined
 * as an AND before the first issue, then the canonical chain. */
function handAuthoredAfter(prs: string[], issues: string[]): AnyGraph {
  const g = handAuthored(null, issues);
  prs.forEach((pr, k) => {
    g.nodes.push({
      id: `after-${k + 1}`,
      kind: "wait",
      wait: { kind: "pr", target: pr, match: { prState: "merged" }, poll: { ...AFTER_POLL }, onTimeout: "escalate" },
    });
    g.edges.push({ from: `after-${k + 1}`, to: "open-1" });
  });
  return g;
}

test("sequenceIssues #1056: `after` four PRs → the hand-written AND-gated chain, compiles", async () => {
  const prs = ["o/r#317", "o/r#318", "o/r#319", "o/r#320"];
  const graph = ok({ issues: ["o/r#312", "o/r#313"], after: prs });
  assertEquivalent(graph, handAuthoredAfter(prs, ["o/r#312", "o/r#313"]));
  assertEquals(validateDeliveryGraph(graph), []);
  const compiled = await compileDeliveryGraph(graph);
  assert(compiled.ok, `expected compile ok, got ${JSON.stringify(compiled)}`);
});

test("sequenceIssues #1056: `after` gates default to a 7-day poll budget", () => {
  const graph = ok({ issues: ["o/r#1"], after: ["o/r#2"] });
  const gate = graph.nodes.find((n) => n.id === "after-1");
  assertEquals(gate.wait.poll, { everyMs: 300_000, timeoutMs: 7 * 24 * 60 * 60 * 1000 });
});

test("sequenceIssues #1056: `after` entry forms resolve to pr / issue / epic waits", async () => {
  const graph = ok({
    issues: ["o/r#1"],
    behind: "o/r#50",
    after: [
      "o/r#2",
      "pr:o/r#3",
      "issue:o/r#4",
      "epic:o/r#5",
      "https://github.com/o/r/pull/6",
      "https://github.com/o/r/issues/7",
      { kind: "issue", ref: "o/r#8" },
    ],
  });
  const waits = graph.nodes.filter((n) => n.id.startsWith("after-")).map((n) => [n.wait.kind, n.wait.target, n.wait.match]);
  assertEquals(waits, [
    ["pr", "o/r#2", { prState: "merged" }],
    ["pr", "o/r#3", { prState: "merged" }],
    ["issue", "o/r#4", { issueState: "completed" }],
    ["epic", "o/r#5", { epicState: "merged" }],
    ["pr", "o/r#6", { prState: "merged" }],
    ["issue", "o/r#7", { issueState: "completed" }],
    ["issue", "o/r#8", { issueState: "completed" }],
  ]);
  // Every gate (and `behind`) feeds the first agent — an AND join.
  const into = graph.edges.filter((e) => e.to === "open-1").map((e) => e.from).sort();
  assertEquals(into, ["after-1", "after-2", "after-3", "after-4", "after-5", "after-6", "after-7", "gate-epic"]);
  assertEquals(validateDeliveryGraph(graph), []);
  const compiled = await compileDeliveryGraph(graph);
  assert(compiled.ok, `expected compile ok, got ${JSON.stringify(compiled)}`);
});

test("sequenceIssues #1056: invalid `after` input is rejected path-qualified", () => {
  for (const [after, path] of [
    ["nope", "after"],
    [["bogus"], "after[0]"],
    [["o/r#0"], "after[0]"],
    [[{ kind: "command", ref: "o/r#1" }], "after[0]"],
    [["issue:https://github.com/o/r/pull/3"], "after[0]"],
    [["o/r#1", "pr:o/r#1"], "after[1]"],
    [Array.from({ length: MAX_SEQUENCE_AFTER + 1 }, (_, i) => `o/r#${i + 1}`), "after"],
  ] as const) {
    const res = buildSequenceGraph({ issues: ["o/r#9"], after });
    assert(!res.ok, `expected rejection for ${JSON.stringify(after)}`);
    assert(res.issues.some((x) => x.path === path), `expected path ${path}, got ${JSON.stringify(res.issues)}`);
  }
  const res = buildSequenceGraph({ issues: ["o/r#9"], parallel: "yes" });
  assert(!res.ok && res.issues.some((x) => x.path === "parallel"));
});

test("sequenceIssues #1056: `parallel: true` fans every issue out after the gates (no chaining)", async () => {
  const graph = ok({ issues: ["o/r#1", "o/r#2", "o/r#3"], after: ["o/r#10", "o/r#11"], parallel: true });
  for (const n of [1, 2, 3]) {
    const into = graph.edges.filter((e) => e.to === `open-${n}`).map((e) => e.from).sort();
    assertEquals(into, ["after-1", "after-2"], `open-${n} released by the gates only`);
  }
  assert(!graph.edges.some((e) => /^merged-/.test(e.from)), "no merged→open chaining in parallel mode");
  assertEquals(validateDeliveryGraph(graph), []);
  const compiled = await compileDeliveryGraph(graph);
  assert(compiled.ok, `expected compile ok, got ${JSON.stringify(compiled)}`);
});

test("sequenceIssues #1056: `parallel` without gates starts every issue immediately", () => {
  const graph = ok({ issues: ["o/r#1", "o/r#2"], parallel: true });
  assert(!graph.edges.some((e) => e.to.startsWith("open-")), "no predecessor edges");
});

test("sequenceIssues #1056: generated prompts close their issue AND satisfy the full-scope rule", () => {
  const prompt = sequenceAgentPrompt("o/r#312");
  assert(/closes o\/r#312/.test(prompt));
  const graph = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:feature", prompt }, emits: [{ name: "pr", type: "pr" }] }], edges: [] };
  assertEquals(validateDeliveryGraph(graph), []);
  // Control: the same close WITHOUT the acknowledgement is rejected — the rule is live.
  const bare = { nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:feature", prompt: "Implement o/r#312 and open a PR that closes o/r#312." } }], edges: [] };
  assert(validateDeliveryGraph(bare).length > 0, "control: a bare close must be rejected");
});

test("sequenceIssues #1056: a parallel fan-out whose gates×issues edges exceed the compiler edge ceiling → rejected at `after`", () => {
  const after = Array.from({ length: 32 }, (_, i) => `o/r#${1000 + i}`);
  const issues = Array.from({ length: 64 }, (_, i) => `o/r#${i + 1}`);
  const found = rejects({ issues, after, parallel: true });
  assert(found.some((i) => i.path === "after" && /too many edges/.test(i.message)), `expected an edge-ceiling rejection, got ${JSON.stringify(found)}`);
});
