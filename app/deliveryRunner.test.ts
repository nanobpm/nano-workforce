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
import { assert, assertEquals, assertRejects } from "#test-assert";
import { prepareDeliveryGraph, renderIdempotencyPreamble, runDeliveryGraph } from "./deliveryRunner.ts";
import { RepoEnvelopeConflictError, RepoEnvelopeUnresolvedError } from "./repoEnvelope.ts";
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
  // Default to a resolvable run-level repository/baseBranch fallback (#739) so the many timeout/id/DI
  // tests below — which don't care about repo provisioning — need not restate it; the per-node
  // repository tests pass their own `options` (declared node repos, `repoless`, unresolved, …).
  const opts = "repoless" in options || "repository" in options ? options : { repository: "owner/repo", baseBranch: "main", ...options };
  const r = await prepareDeliveryGraph(graph, opts);
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
  // Every agent node's appendPrompt is prefixed with the idempotency preflight (#551), then the
  // authored prompt (this node declares no emits, so the emit contract adds nothing).
  assertEquals(agent, { jobType: "senior:feature", appendPrompt: renderIdempotencyPreamble() + "un-draft + merge #B", timeout: "PT10M" });

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

test("agent node classifier-emit contract (#506): a declared `emits` threads the emit instruction into appendPrompt; a no-emit node leaves it untouched", async () => {
  // #506: a guarded split (S7) routes on a producer's emitted scalar, published from the engine
  // variable named exactly after the fact. A real `senior:*` agent completes with the Output-contract
  // envelope and would never return that fact unless TOLD — so an agent node that declares `emits`
  // must carry the emit contract in its `appendPrompt` (its only steering channel), while a plain
  // implementation node (no emits) must be byte-for-byte unchanged.
  const graph: DeliveryGraph = {
    name: "classifier",
    nodes: [
      { id: "adopt", kind: "agent", agent: { jobType: "senior:feature", prompt: "adopt the package" }, emits: [{ name: "result", type: "string", description: "breaking | compatible" }] },
      { id: "plain", kind: "agent", agent: { jobType: "senior:feature", prompt: "just implement it" } },
    ],
    edges: [{ from: "adopt.result", to: "plain", when: "adopt.result", equals: "breaking" }, { from: "adopt", to: "plain", default: true }],
  };
  const p = await prepareOk(graph);
  const agents = Object.values(p.nodeInputs).filter((v) => "jobType" in v) as Array<Record<string, unknown>>;
  const adopt = agents.find((v) => String(v.appendPrompt).includes("adopt the package"));
  const plain = agents.find((v) => String(v.appendPrompt).includes("just implement it"));

  // The emit-declaring node keeps its authored prompt AND gains the emit contract naming its fact,
  // both AFTER the unconditional idempotency preflight (#551).
  assert(adopt, "the emit-declaring agent node must be seeded");
  const adoptPrompt = String(adopt?.appendPrompt);
  assert(adoptPrompt.startsWith(renderIdempotencyPreamble()), "the idempotency preflight leads every agent prompt");
  assert(adoptPrompt.includes("adopt the package"), "the authored prompt is preserved after the preflight");
  assert(adoptPrompt.includes("Classifier emit contract"), `the emit contract must be threaded in, got: ${adoptPrompt}`);
  assert(adoptPrompt.includes("`result`") && adoptPrompt.includes("(string)"), "the declared fact name + type must be surfaced to the agent");
  assert(adoptPrompt.includes("breaking | compatible"), "the fact's optional description rides the contract");
  assert(adoptPrompt.includes("AGENT_RESULT_FILE"), "the contract names the completion channel the fact rides");

  // A node that declares NO facts still carries the preflight, then exactly the authored prompt — the
  // emit contract contributes nothing.
  assertEquals(plain?.appendPrompt, renderIdempotencyPreamble() + "just implement it");
});


test("agent node idempotency preflight (#551): every agent prompt leads with adopt-and-report guidance; non-agent nodes are untouched", async () => {
  // #551: a delivery agent node dispatches a raw retry-carrying `senior:feature` job with no
  // PR-existence guard, so a re-dispatch opened a DUPLICATE PR (instance 43077 n0 → #979/#980). The
  // fix threads an unconditional idempotency preflight into every agent node's `appendPrompt` telling
  // the agent to CHECK for an existing claim/open PR and ADOPT-AND-REPORT it rather than open a second.
  // Pin: (a) both agent nodes lead with the preflight regardless of emits, (b) it names the check +
  // the adopt-and-report contract, and (c) wait/human/connector nodes never carry it.
  const graph: DeliveryGraph = {
    name: "idempotency",
    nodes: [
      { id: "emitter", kind: "agent", agent: { jobType: "senior:feature", prompt: "do X" }, emits: [{ name: "result", type: "string" }] },
      { id: "plain", kind: "agent", agent: { jobType: "senior:feature", prompt: "do Y" } },
      { id: "gate", kind: "wait", wait: { kind: "pr", target: "owner/repo#1", match: { prState: "merged" } } },
    ],
    edges: [{ from: "emitter", to: "plain" }, { from: "plain", to: "gate" }],
  };
  const p = await prepareOk(graph);
  const preamble = renderIdempotencyPreamble();

  // Every agent node leads with the preflight, ahead of its authored prompt (and any emit contract).
  const agents = Object.values(p.nodeInputs).filter((v) => "jobType" in v) as Array<Record<string, unknown>>;
  assertEquals(agents.length, 2, "both agent nodes are seeded");
  for (const a of agents) {
    const prompt = String(a.appendPrompt);
    assert(prompt.startsWith(preamble), "the preflight is the leading prefix of every agent prompt");
    assert(prompt.includes("Idempotency preflight"), "the preflight heading is present");
    assert(prompt.includes("DO NOT open a second PR") || prompt.includes("do not open a second"), "it forbids a duplicate PR");
    assert(prompt.includes("adopt and report"), "it names the adopt-and-report contract");
  }

  // The preflight is unconditional but AGENT-ONLY — a wait node's seed carries no prompt at all.
  const wait = Object.values(p.nodeInputs).find((v) => "gateKey" in v) as Record<string, unknown> | undefined;
  assert(wait, "the wait node is seeded");
  assert(!("appendPrompt" in wait!), "a non-agent node never carries the agent idempotency preflight");
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

test("a per-node timeout is normalized (lower-case → canonical) and a malformed one falls back to the run value (#505)", async () => {
  // A graph built programmatically (bypassing the OpenAPI pattern) can carry a lower-case or malformed
  // per-node duration. The runner normalizes it through `isoDuration` so a bad value never bakes an
  // uninterpretable boundary timer: `pt4h` → `PT4H`, and `nonsense` falls back to the run-level default.
  const graph: DeliveryGraph = {
    name: "per-node normalization",
    nodes: [
      { id: "lower", kind: "agent", agent: { jobType: "senior:feature", timeout: "pt4h" } },
      { id: "bad", kind: "connector", connector: { target: "slack:post", dedupeKey: "n-1", timeout: "nonsense" } },
    ],
    edges: [{ from: "lower", to: "bad" }],
  } as unknown as DeliveryGraph;
  const p = await prepareOk(graph, { nodeTimeout: "PT2H" });
  const agent = Object.values(p.nodeInputs).find((v) => (v as { jobType?: string }).jobType === "senior:feature") as
    | { timeout: string }
    | undefined;
  const connector = Object.values(p.nodeInputs).find((v) => (v as { target?: string }).target === "slack:post") as
    | { timeout: string }
    | undefined;

  assertEquals(agent?.timeout, "PT4H"); // lower-case normalized to canonical form
  assertEquals(connector?.timeout, "PT2H"); // malformed value rejected → run-level default
});

test("a RUN-LEVEL timeout is normalized (lower-case → canonical) and a malformed one falls back to the default (#505)", async () => {
  // A programmatic caller of prepareDeliveryGraph/runDeliveryGraph bypasses the OpenAPI/door validators,
  // so a lower-case or malformed run-level `nodeTimeout` must not become the fallback baked into a node's
  // boundary timer FEEL. isoDuration canonicalizes it (`pt3h` → `PT3H`) at the run level too, and a
  // malformed value falls back to the DEFAULTS run value rather than an uninterpretable duration.
  const lower = await prepareOk(GRAPH, { nodeTimeout: "pt3h" });
  for (const v of Object.values(lower.nodeInputs).filter((v) => "timeout" in v)) {
    assertEquals((v as { timeout: string }).timeout, "PT3H"); // lower-case run value normalized
  }
  const bad = await prepareOk(GRAPH, { nodeTimeout: "nonsense" });
  for (const v of Object.values(bad.nodeInputs).filter((v) => "timeout" in v)) {
    assertEquals((v as { timeout: string }).timeout, "PT1H"); // malformed run value → PT1H default, never baked raw
  }
});

test("a wait node's per-node poll.timeoutMs drives its escalation boundary while a sibling keeps the run/default (#462)", async () => {
  // AC (#462): a `wait` node declaring `poll.timeoutMs` seeds nodeInputs.<el>.probeTimeout derived
  // from that budget (the compiled `=probeTimeout` boundary), while a sibling wait WITHOUT a declared
  // timeout keeps the run-level value. Mirrors the per-node `everyMs → probePollEvery` override that
  // already exists — the escalation boundary is the one budget that was silently ignored, so a 7-day
  // gate escalated at the 30-minute run default.
  const graph: DeliveryGraph = {
    name: "per-node wait timeout",
    nodes: [
      { id: "long-gate", kind: "wait", wait: { kind: "pr", target: "owner/repo#1", match: { prState: "merged" }, poll: { timeoutMs: 604_800_000 } } },
      { id: "default-gate", kind: "wait", wait: { kind: "pr", target: "owner/repo#2", match: { prState: "merged" } } },
    ],
    edges: [{ from: "long-gate", to: "default-gate" }],
  };
  const p = await prepareOk(graph, { probeTimeout: "PT20M", runKey: "run-462" });
  const waits = Object.values(p.nodeInputs).filter((v) => "gateKey" in v) as Array<{ gateKey: string; probeTimeout: string }>;
  const byGate = (suffix: string) => waits.find((w) => w.gateKey.endsWith(suffix));
  // Element ids are positional by sorted node id: default-gate → n0, long-gate → n1.
  assertEquals(byGate(":n1")?.probeTimeout, "PT604800S"); // 7 days in seconds — the per-node budget wins
  assertEquals(byGate(":n0")?.probeTimeout, "PT20M"); // sibling keeps the run-level value
});

test("an invalid per-node poll.timeoutMs/everyMs falls back to the run-level ctx.* override, not the built-in default (#462)", async () => {
  // Guard against the JS-truthiness gap: a negative `poll.timeoutMs` (`-1`) is truthy, so a bare
  // `probe.poll?.timeoutMs ? readinessTimeout(probe, {}) : ctx.probeTimeout` would route to
  // `readinessTimeout(probe, {})`, which rejects `< 1` and — with `env: {}` — returns the built-in
  // PT30M default, silently discarding the run/dispatch override. An invalid value must fall through
  // to `ctx.*` (the run-level value) instead. Same for `everyMs`.
  const graph: DeliveryGraph = {
    name: "invalid per-node budget",
    nodes: [
      {
        id: "bad-gate",
        kind: "wait",
        wait: { kind: "pr", target: "owner/repo#1", match: { prState: "merged" }, poll: { timeoutMs: -1, everyMs: -5 } },
      },
    ],
    edges: [],
  };
  const p = await prepareOk(graph, { probeTimeout: "PT20M", probePollEvery: "PT42S", runKey: "run-462b" });
  const wait = Object.values(p.nodeInputs).find((v) => "gateKey" in v) as { probeTimeout: string; probePollEvery: string } | undefined;
  assertEquals(wait?.probeTimeout, "PT20M"); // run-level override, NOT the built-in PT30M default
  assertEquals(wait?.probePollEvery, "PT42S"); // run-level cadence, NOT DEFAULT_EVERY_MS
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
  const r = await runDeliveryGraph(engine, GRAPH, { repoless: true });
  assert(r.ok, `expected ok:true, got ${JSON.stringify(r)}`);
  assertEquals(r.handle.processInstanceKey, "987654321");
  assertEquals(typeof r.handle.processInstanceKey, "string");
});

// Per-node repository isolation (issue #739): the delivery-graph runner seeds the canonical
// `io.nanobpm.agentTask.repository` isolation envelope PER agent cell as flattened `<zeebe:taskHeaders>`
// (`io.nanobpm.agentTask.repository.url`, …) injected into the deployable BPMN — NOT as a single
// run-root process variable. Each agent node's effective repository is its own declared `agent.repository`
// (`agent.baseBranch`), else the run-level `repository`/`baseBranch` fallback. This lets one graph fan out
// across DIFFERENT repos (each cell its own isolated clone) without forcing `repoless`. These pin the
// per-node headers the harness reads and the loud-failure invariants (#729 preserved/strengthened).
function agentHeaders(bpmn: string): string[] {
  return (bpmn.match(/io\.nanobpm\.agentTask\.[^\n]*/g) ?? []).map((s) => s.trim());
}

test("prepareDeliveryGraph injects the repository envelope PER agent cell from the run-level fallback (#684/#686/#739)", async () => {
  const p = await prepareOk(GRAPH, { repository: "owner/repo", baseBranch: "main" });
  const headers = agentHeaders(p.bpmn);
  // The run's single agent cell (`open-b`) carries the flattened envelope headers.
  assert(headers.some((h) => h.includes('repository.url" value="https://github.com/owner/repo.git"')), `expected a repository.url header, got ${JSON.stringify(headers)}`);
  assert(headers.some((h) => h.includes('repository.ref" value="main"')), "ref = base branch");
  assert(headers.some((h) => h.includes('repository.baseRef" value="main"')), "baseRef = base branch");
  assert(headers.some((h) => h.includes('repository.provider" value="github"')), "provider header");
  assert(headers.some((h) => h.includes('repository.singleBranch" value="true"')), "branch-scoped blobless clone (#287)");
  assert(headers.some((h) => h.includes('repository.filter" value="blob:none"')), "blobless filter");
  // No `__repoSpec` marker survives injection — it is the compiler's digest-stable anchor only.
  assert(!p.bpmn.includes("__repoSpec"), "the __repoSpec marker is fully replaced");
  // No run-root `io.nanobpm.agentTask` variable — the envelope rides headers now, not a run variable.
});

test("a node's DECLARED repository/baseBranch WINS over the run-level fallback; a bare node falls back (#739)", async () => {
  const graph: DeliveryGraph = {
    name: "cross-repo fan-out",
    nodes: [
      { id: "own", kind: "agent", agent: { jobType: "senior:feature", prompt: "own repo", repository: "acme/widget", baseBranch: "develop" } },
      { id: "fallback", kind: "agent", agent: { jobType: "senior:feature", prompt: "run repo" } },
    ],
    edges: [{ from: "own", to: "fallback" }],
  };
  const p = await prepareOk(graph, { repository: "owner/repo", baseBranch: "main" });
  const headers = agentHeaders(p.bpmn);
  // The declared node points at its OWN repo + base…
  assert(headers.some((h) => h.includes('repository.url" value="https://github.com/acme/widget.git"')), "declared repo wins");
  assert(headers.some((h) => h.includes('repository.ref" value="develop"')), "declared base wins");
  // …while the bare node inherits the run-level fallback.
  assert(headers.some((h) => h.includes('repository.url" value="https://github.com/owner/repo.git"')), "bare node falls back to run repo");
  assert(headers.some((h) => h.includes('repository.ref" value="main"')), "bare node falls back to run base");
});

test("a fully NODE-PROVISIONED cross-repo graph dispatches with NO run-level repository and NO repoless (#739)", async () => {
  const graph: DeliveryGraph = {
    name: "self-provisioned",
    nodes: [
      { id: "a", kind: "agent", agent: { jobType: "senior:feature", prompt: "a", repository: "acme/one" } },
      { id: "b", kind: "agent", agent: { jobType: "senior:feature", prompt: "b", repository: "acme/two" } },
    ],
    edges: [{ from: "a", to: "b" }],
  };
  // Neither a run-level repository/baseBranch NOR repoless — every node self-provisions.
  const p = await prepareOk(graph, {});
  const headers = agentHeaders(p.bpmn);
  assert(headers.some((h) => h.includes("acme/one.git")), "node a → acme/one");
  assert(headers.some((h) => h.includes("acme/two.git")), "node b → acme/two");
});

test("a declared repository WITHOUT a base branch omits ref/baseRef — the harness clones the default branch (#739)", async () => {
  const graph: DeliveryGraph = {
    name: "no base",
    nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:feature", prompt: "a", repository: "acme/one" } }],
    edges: [],
  };
  // Call the runner DIRECTLY with no run-level fallback (the shared `prepareOk` helper would inject one),
  // so the node's declared repo is the sole source and its base is genuinely unknown.
  const r = await prepareDeliveryGraph(graph, {});
  assert(r.ok, `expected ok:true, got ${JSON.stringify(r)}`);
  const headers = agentHeaders(r.prepared.bpmn);
  assert(headers.some((h) => h.includes('repository.url" value="https://github.com/acme/one.git"')), "url present");
  assert(!headers.some((h) => h.includes("repository.ref")), "no ref → clone the repo default branch");
  assert(!headers.some((h) => h.includes("repository.baseRef")), "no baseRef either");
});

test("prepareDeliveryGraph seeds NO envelope ONLY on an EXPLICIT repoless run — the conscious opt-out (#729)", async () => {
  const p = await prepareOk(GRAPH, { repoless: true });
  assert(!p.bpmn.includes("io.nanobpm.agentTask.repository"), "an explicit repoless run must emit no repository envelope");
  assert(!p.bpmn.includes("__repoSpec"), "the marker is stripped on a repoless run too");
});

test("prepareDeliveryGraph THROWS on an unresolved repo/base when NOT repoless — never a silent shared launch dir (#729/#739)", async () => {
  // Issue #729: the fan-out seed is REQUIRED. An agent cell that declares no repository AND has no
  // run-level repository fallback (and no explicit `repoless` opt-out) must fail LOUDLY at prepare time
  // rather than silently degrade to the worker's shared launch dir (issue #684's field failure). GRAPH's
  // `open-b` node declares no repository. A run-level repository WITHOUT a base is NOT unresolved (#739:
  // the cell clones the repo's default branch) — only a missing/blank repository is unresolved.
  for (const options of [{}, { baseBranch: "main" }, { repository: "  ", baseBranch: "main" }]) {
    await assertRejects(
      () => prepareDeliveryGraph(GRAPH, options),
      RepoEnvelopeUnresolvedError,
    );
  }
});

test("a run-level repository WITHOUT a base branch RESOLVES every bare cell — the default-branch clone (#739)", async () => {
  // The #739 relaxation: an issue ref carries only `owner/repo`, no branch. A run-level repository with
  // no base is a legitimate fallback — each bare cell clones that repo's DEFAULT branch, no ref header.
  const r = await prepareDeliveryGraph(GRAPH, { repository: "owner/repo" });
  assert(r.ok, `expected ok:true, got ${JSON.stringify(r)}`);
  const headers = agentHeaders(r.prepared.bpmn);
  assert(headers.some((h) => h.includes('repository.url" value="https://github.com/owner/repo.git"')), "bare cell inherits run repo");
  assert(!headers.some((h) => h.includes("repository.ref")), "no run base → clone the default branch");
});

test("prepareDeliveryGraph THROWS on a malformed run-level repository rather than emitting a bogus clone URL (#729)", async () => {
  // A value that is not exactly `owner/repo` (a trailing `.git`) is an UNRESOLVED fallback — it must
  // throw, never degrade to a double-suffixed `…/owner/repo.git.git` clone URL.
  await assertRejects(
    () => prepareDeliveryGraph(GRAPH, { repository: "owner/repo.git", baseBranch: "main" }),
    RepoEnvelopeUnresolvedError,
  );
});

test("a malformed NODE-declared repository is REJECTED at validation (#739)", async () => {
  const graph: DeliveryGraph = {
    name: "bad node repo",
    nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:feature", prompt: "a", repository: "acme/one.git" } }],
    edges: [],
  };
  // A node whose declared repository is malformed (a trailing `.git`) is caught by the semantic validator
  // as `invalid-node-repository` — the graph never compiles, so it can never inject a bogus clone URL
  // nor silently fall back to the run level (which would mask the operator's typo).
  const r = await prepareDeliveryGraph(graph, { repository: "owner/repo", baseBranch: "main" });
  assert(!r.ok, "a malformed node repository fails to prepare");
  assert(r.errors.some((e) => e.path === "nodes[0].agent.repository"), `expected an invalid-node-repository error, got ${JSON.stringify(r.errors)}`);
});

test("prepareDeliveryGraph THROWS when repoless is combined with repository/baseBranch — never silently disables isolation (#729)", async () => {
  // `repoless: true` is mutually exclusive with `repository`/`baseBranch`. The dispatch door rejects the
  // conflicting shape with a 400, but a PROGRAMMATIC caller that bypasses the door could pass both — and
  // the runner would silently drop the repo/base and emit no envelope, re-disabling the exact isolation
  // the repo/base named. The runner must fail LOUDLY too (defense-in-depth).
  for (const options of [
    { repoless: true, repository: "owner/repo", baseBranch: "main" },
    { repoless: true, repository: "owner/repo" },
    { repoless: true, baseBranch: "main" },
  ]) {
    await assertRejects(
      () => prepareDeliveryGraph(GRAPH, options),
      RepoEnvelopeConflictError,
    );
  }
});

test("the canonical `agent → converge-merge → wait[pr merged]` graph DISPATCHES with a fact-bound wait target (#570)", async () => {
  // Regression for #570: a `wait[pr]` node whose `target` is a fact reference (`open.pr`, the #548
  // late-binding shape the guide documents as canonical) COMPILED+staged but threw at dispatch —
  // `buildNodeInput`'s wait case eagerly `parseProbe`'d the fact-ref target as a literal `owner/repo#N`
  // and aborted the whole launch. It must now LAUNCH (the target is resolved at runtime by the
  // readiness-probe worker), while a genuinely malformed literal still fails loudly (see the
  // deliveryRunner sibling assertion + readiness.test.ts).
  const graph: DeliveryGraph = {
    name: "canonical land shape",
    nodes: [
      { id: "open", kind: "agent", agent: { jobType: "senior:feature", prompt: "open a PR" }, emits: [{ name: "pr", type: "pr" }] },
      { id: "converge-merge", kind: "connector", connector: { target: "converge-merge", payload: { pr: "open.pr" } } },
      { id: "merged", kind: "wait", wait: { kind: "pr", target: "open.pr", match: { prState: "merged" }, onTimeout: "escalate" } },
    ],
    edges: [
      { from: "open.pr", to: "converge-merge" },
      { from: "open.pr", to: "merged" },
    ],
  };
  // Dispatch through the full launch path (prepare → deploy → createInstance). Before the fix this
  // threw synchronously inside buildNodeInput; now it launches.
  const engine = {
    deployResources: async () => [],
    createInstance: async () => ({ processInstanceKey: "555" }),
  };
  const r = await runDeliveryGraph(engine, graph, { repoless: true });
  assert(r.ok, `expected the canonical fact-bound wait[pr] graph to launch, got ${JSON.stringify(r)}`);
  assertEquals(r.handle.processInstanceKey, "555");
});
