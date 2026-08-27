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

/** The sub-process element id of the PLANNED human user task in a compiled graph — i.e. the
 * delivery-human-task element that is NOT a bounded node's __esc timeout twin. Returns "" if none. */
function humanTaskSubEl(bpmn: string): string {
  const parts = bpmn.split('<bpmn:userTask id="delivery-human-task__');
  for (let k = 1; k < parts.length; k++) {
    const id = parts[k].slice(0, parts[k].indexOf('"'));
    if (!id.endsWith("__esc")) return id;
  }
  return "";
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

test("#543 transcript correlation: only an agent node seeds transcriptUrlBase and emits transcriptUrl", async () => {
  const r = await compileOk(RELEASE_RUNBOOK);
  // The agent node's subProcess ioMapping threads the seeded base IN (so the completing worker can
  // build its own jobKey-scoped URL) and propagates the worker-set transcriptUrl OUT to the instance.
  assert(
    /<zeebe:input source="=if \(is defined\(transcriptUrlBase\)\) then transcriptUrlBase else null" target="transcriptUrlBase"/.test(
      r.bpmn,
    ),
    "an agent node seeds transcriptUrlBase",
  );
  assert(
    /<zeebe:output source="=if \(is defined\(transcriptUrl\)\) then transcriptUrl else null" target="transcriptUrl"/.test(r.bpmn),
    "an agent node propagates the worker-emitted transcriptUrl up to the instance scope",
  );
  // RELEASE_RUNBOOK has exactly ONE agent node — wait/human/connector must NOT carry the mapping.
  assertEquals(
    (r.bpmn.match(/target="transcriptUrl"/g) ?? []).length,
    1,
    "only the agent node emits transcriptUrl (non-agent kinds do not)",
  );
  assertEquals(
    (r.bpmn.match(/target="transcriptUrlBase"/g) ?? []).length,
    1,
    "only the agent node seeds transcriptUrlBase",
  );
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

test("#568 epic wait kind: an `epic` wait node compiles to a readiness gate and seeds its probe verbatim", async () => {
  // A new `wait` kind `epic` (issue #568) gates a graph on an nwf plan-fanout epic reaching "fully
  // merged", keyed by its planKey. It reuses the SAME readiness-gate machinery as `pr` (Decision 3 —
  // never a second wait loop), so it compiles through with no BPMN branch: the node delegates to
  // `pr.readiness-probe` and seeds `nodeInputs.<el>.probe` (the whole descriptor) verbatim.
  const graph = {
    name: "epic gate",
    nodes: [
      { id: "gate-epic", kind: "wait", wait: { kind: "epic", target: "nanobpm/nano-ide#488", match: { epicState: "merged" }, onTimeout: "escalate" } },
      { id: "start-b", kind: "agent", agent: { jobType: "senior:feature", prompt: "implement #567" } },
    ],
    edges: [{ from: "gate-epic", to: "start-b" }],
  };
  const r = await compileOk(graph);
  const types = new Set([...r.bpmn.matchAll(/<zeebe:taskDefinition type="([^"]+)"/g)].map((m) => m[1]));
  assert(types.has("pr.readiness-probe"), "the epic wait delegates to the shared readiness-probe gate");
  // The epic wait's element (n0 — sorted node id `gate-epic` precedes `start-b`) seeds its probe.
  assert(r.bpmn.includes('source="=nodeInputs.n0.probe" target="probe"'), "the epic wait seeds its probe descriptor verbatim");
});

test("#499 human context: the human user-task seeds prompt/nodeId/emit context so its generic form is not contextless", async () => {
  const r = await compileOk(RELEASE_RUNBOOK);
  // The human node's subProcess ioMapping must thread the authored prompt + node identity + emit
  // context from `nodeInputs.<el>` onto the user task (the form reads them). A dropped prompt input is
  // exactly the contextless-form bug (#499). Locate the PLANNED human task (not an `__esc` twin).
  const subEl = humanTaskSubEl(r.bpmn);
  assert(subEl !== "", "the graph inlines a planned human user task");
  assert(r.bpmn.includes(`source="=nodeInputs.${subEl}.prompt" target="prompt"`), "the human task seeds its authored prompt");
  assert(r.bpmn.includes(`source="=nodeInputs.${subEl}.nodeId" target="nodeId"`), "the human task seeds its node identity");
  // The emit label/mode are DERIVED in FEEL from the seeded emits list (single source of truth) — a
  // single-quoted attribute so the literal quotes survive the engine deploy path.
  assert(
    r.bpmn.includes(`source='=if count(nodeInputs.${subEl}.emits) = 0 then "none" else "typed"' target="emitMode"`),
    "emitMode is derived from the emits count",
  );
  assert(
    r.bpmn.includes(`for _e in nodeInputs.${subEl}.emits return _e.name`) && r.bpmn.includes('target="emitLabel"'),
    "emitLabel is derived from the emits list",
  );
});

test("#499 escalation context: an agent-node timeout escalation seeds a context line naming the node, its job type, and the elapsed SLA", async () => {
  const r = await compileOk(RELEASE_RUNBOOK);
  // The `__esc` timeout-escalation user task previously carried NO ioMapping — a blank form that never
  // said a timeout occurred, on which node. It must now seed a `prompt` context line from a compile-time
  // literal (node id + job type) concatenated with the runtime elapsed SLA (`nodeTimeout`).
  const start = r.bpmn.indexOf('<bpmn:userTask id="delivery-human-task__n1__esc"');
  assert(start !== -1, "a bounded node inlines an escalation user task");
  const escBlock = r.bpmn.slice(start, r.bpmn.indexOf("</bpmn:userTask>", start));
  assert(escBlock.includes('target="prompt"'), "the escalation task seeds a prompt context line");
  assert(escBlock.includes("Node open-b (senior:feature) exceeded its SLA ("), "the context names the node and its job type");
  assert(escBlock.includes("string(nodeTimeout)"), "the context reports the elapsed SLA at runtime");
  assert(escBlock.includes('="none"') && escBlock.includes('target="emitMode"'), "the escalation labels its emit field N/A so the generic form hides the inert value input");
});

// The #514 motivating case: a `capability` wait gate that emits a version, escalating on a
// false-negative. Its escalation must be self-diagnosing (Defect A) AND resumable with its emit
// (Defect B). Two emit shapes (`version` → `detail`, `artifact` → `resolvedArtifact`) exercise the
// per-emit-type mapping.
const CAP_GATE = {
  name: "capability gate",
  nodes: [
    { id: "gv", kind: "agent", agent: { jobType: "senior:feature", prompt: "ship the rollup" } },
    {
      id: "n2",
      kind: "wait",
      wait: {
        kind: "capability",
        target: "github-releases:nanobpm/nano-ide",
        match: { package: "@nanobpm/urban", capabilityRef: "#468" },
        onTimeout: "escalate",
      },
      emits: [{ name: "publishedVersion", type: "version" }],
    },
    {
      id: "n3",
      kind: "wait",
      wait: {
        kind: "capability",
        target: "github-releases:nanobpm/nano-ide",
        match: { package: "@nanobpm/urban", capabilityRef: "#469" },
        onTimeout: "escalate",
      },
      emits: [{ name: "artifactRef", type: "artifact" }],
    },
    { id: "sink", kind: "connector", connector: { target: "npm:install", dedupeKey: "c1" } },
  ],
  edges: [
    { from: "gv", to: "n2" },
    { from: "n2.publishedVersion", to: "n3" },
    { from: "n3.artifactRef", to: "sink" },
  ],
};

/** The subProcess element id the compiler assigned to a node (elements are positional `n<k>`, not the
 * node id). Located via the subProcess `name="<kind>: <nodeId>"`. */
function elementForNode(bpmn: string, nodeId: string): string {
  const m = bpmn.match(new RegExp(`<bpmn:subProcess id="([^"]+)" name="[^"]*: ${nodeId}"`));
  assert(m, `a subProcess for node ${nodeId} exists`);
  return m![1];
}

/** Slice a compiled BPMN to a node's escalation user task body. */
function escBlockForNode(bpmn: string, nodeId: string): string {
  const esc = `delivery-human-task__${elementForNode(bpmn, nodeId)}__esc`;
  const start = bpmn.indexOf(`<bpmn:userTask id="${esc}"`);
  assert(start !== -1, `escalation task ${esc} for node ${nodeId} exists`);
  return bpmn.slice(start, bpmn.indexOf("</bpmn:userTask>", start));
}

test("#514 Defect A: a capability wait-gate escalation surfaces the probe's last detail, target/match, and observed releases so it is self-diagnosing", async () => {
  const r = await compileOk(CAP_GATE);
  const esc = escBlockForNode(r.bpmn, "n2");
  // The read-only prompt context now folds in the RUNTIME last probe detail + observed candidate summary.
  assert(esc.includes('target="prompt"'), "the escalation seeds a prompt context line");
  assert(esc.includes("Last probe: ") && esc.includes("if (is defined(detail)) then string(detail)"), "the prompt folds in the last probe detail");
  assert(esc.includes("Observed: ") && esc.includes("if (is defined(observed)) then string(observed)"), "the prompt folds in the observed candidate summary");
  // Discrete diagnostic task variables the form/agent can bind directly.
  assert(esc.includes('target="probeDetail"'), "the escalation surfaces the probe's last detail as a discrete variable");
  assert(esc.includes('target="observedReleases"'), "the escalation surfaces the observed candidate releases");
  assert(/source="=if \(is defined\(probe\.target\)\) then probe\.target else nodeInputs\.[^"]+\.probe\.target" target="probeTarget"/.test(esc), "the escalation surfaces the resolved (late-bound) probe target");
  assert(/source="=nodeInputs\.[^"]+\.probe\.match" target="probeMatch"/.test(esc), "the escalation surfaces the resolved probe match");
});

test("#514 Defect B: a resumed wait-node escalation maps the operator-supplied value onto the node's emit source (version→detail, artifact→resolvedArtifact)", async () => {
  const r = await compileOk(CAP_GATE);
  // Red before the fix: the wait escalation forced emitMode="none" (hiding the value field) and carried
  // NO output mapping, so a resume published `<el>_<fact> = null`, starving the downstream consumer.
  const escV = escBlockForNode(r.bpmn, "n2");
  // A `version` emit is sourced from `detail` — the operator's captured `value` must be mapped there.
  assert(escV.includes('="typed"') && escV.includes('target="emitMode"'), "a wait node with emits PRESENTS its value field on escalation, not 'none'");
  assert(escV.includes("publishedVersion (version)") && escV.includes('target="emitLabel"'), "the emit label names the awaited fact");
  assert(/source="=if \(is defined\(value\)\) then value else null" target="detail"/.test(escV), "the operator's value is mapped onto the version emit's source var (detail)");

  const escA = escBlockForNode(r.bpmn, "n3");
  // An `artifact` emit is ALSO sourced from the generic form's single `value` field (the form has no
  // `resolvedArtifact` field), mapped onto the artifact emit's source var (resolvedArtifact) — so an
  // artifact wait-node escalation is actually resumable via the UI.
  assert(/source="=if \(is defined\(value\)\) then value else null" target="resolvedArtifact"/.test(escA), "the operator's value is mapped onto the artifact emit's source var (resolvedArtifact)");
});

test("#514 Defect B: a service-node escalation (agent) stays inert — no emit field, no resume output mapping (only wait resumes)", async () => {
  const r = await compileOk(CAP_GATE);
  const esc = escBlockForNode(r.bpmn, "gv");
  assert(esc.includes('="none"') && esc.includes('target="emitMode"'), "an agent-node escalation keeps its emit field hidden");
  assert(!esc.includes("<bpmn:output") && !esc.includes("<zeebe:output"), "an agent-node escalation carries no emit-source output mapping");
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

test("converge-merge worked graph: agent → connector[converge-merge] → wait[pr,merged] compiles with NO human node (retires the manual land gate, #500)", async () => {
  const graph = {
    name: "open → converge+merge → wait merged",
    nodes: [
      { id: "open", kind: "agent", agent: { jobType: "senior:feature", prompt: "Implement the change and open a PR." } },
      { id: "land", kind: "connector", connector: { target: "converge-merge", payload: { pr: "acme/repo#123" } } },
      { id: "merged", kind: "wait", wait: { kind: "pr", target: "acme/repo#123", match: { prState: "merged" }, onTimeout: "escalate" } },
    ],
    edges: [
      { from: "open", to: "land" },
      { from: "land", to: "merged" },
    ],
  };
  const r = await compileOk(graph);
  // The canonical shape has NO human land-* gate — convergence is driven by the connector itself.
  assertEquals(r.humanNodes.length, 0, "no human node bridges the PR to convergence");
  // The connector is a side effect, naming its converge-merge target; the wait gate is read-only.
  const connector = r.sideEffects.find((s) => s.nodeId === "land");
  assertEquals(connector?.kind, "connector");
  assert(connector?.description.includes("converge-merge"), "the side-effect names the converge-merge target");
  assert(!r.sideEffects.some((s) => s.nodeId === "merged"), "the wait gate is not a side effect");
});

test("#548 no-literal converge shape: an emitted `pr` fact late-binds the connector (boundFacts) AND the wait target (context put)", async () => {
  // The canonical `agent → connector[converge-merge] → wait[pr, merged]` shape carrying NO hardcoded PR
  // number: `open` emits the PR it opened as a typed `pr` fact, and both downstream consumers reference
  // it (`open.pr`) on incoming fact edges. The compiler must (a) publish the fact as `<open>_pr`, (b)
  // thread it into the connector's `boundFacts` input, and (c) rewrite the wait's probe target via
  // `context put` to poll the late-bound PR.
  const graph = {
    name: "no-literal converge",
    nodes: [
      {
        id: "open",
        kind: "agent",
        agent: { jobType: "senior:feature", prompt: "Implement and open a PR." },
        emits: [{ name: "pr", type: "pr" }],
      },
      { id: "land", kind: "connector", connector: { target: "converge-merge", payload: { pr: "open.pr" } } },
      { id: "merged", kind: "wait", wait: { kind: "pr", target: "open.pr", match: { prState: "merged" } } },
    ],
    edges: [
      { from: "open.pr", to: "land" },
      { from: "open.pr", to: "merged" },
    ],
  };
  const r = await compileOk(graph);
  const openEl = r.resolved.edges.find((e) => e.from === "open.pr")?.fromNode;
  assertEquals(openEl, "open", "the fact edge resolves to the `open` producer node");
  // (a) the producer publishes its declared `pr` emit into a flat `<element>_pr` parent variable.
  assert(/target="[^"]*_pr"/.test(r.bpmn), "the agent's `pr` emit is published as `<element>_pr`");
  // (b) the connector receives the fact list — its `boundFacts` input names the `pr` fact + producer.
  assert(/target="boundFacts"/.test(r.bpmn), "the connector is threaded a boundFacts input");
  assert(/name: "pr"/.test(r.bpmn), "the boundFacts entry names the `pr` fact");
  // (c) the wait probe target is late-bound via `context put`, not the raw `open.pr` reference literal.
  assert(/context put\([^)]*\.probe, "target",/.test(r.bpmn), "the wait probe target is rewritten via context put");
  assert(!/target="owner\/repo#/.test(r.bpmn), "no hardcoded PR literal is compiled into the graph");
});

test("a wait node with a LITERAL pr target compiles the probe unchanged (no spurious context put)", async () => {
  const graph = {
    name: "literal target",
    nodes: [
      { id: "open", kind: "agent", agent: { jobType: "senior:feature", prompt: "open a PR" } },
      { id: "merged", kind: "wait", wait: { kind: "pr", target: "acme/repo#7", match: { prState: "merged" } } },
    ],
    edges: [{ from: "open", to: "merged" }],
  };
  const r = await compileOk(graph);
  assert(!/context put/.test(r.bpmn), "a literal target is not wrapped in a context put rewrite");
  assert(/source="=nodeInputs\.[^"]+\.probe" target="probe"/.test(r.bpmn), "the probe is seeded directly from nodeInputs");
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

// ── S7: guarded (conditional) edges compile to an exclusive gateway (ADR 0005 S7) ──────────────────
// A guarded split node's fan-out is an EXCLUSIVE gateway with a FEEL condition per guarded flow and a
// default flow; a fan-in re-converging its branches is an EXCLUSIVE merge (first-token-proceeds), not
// the parallel AND-join that would deadlock on the untaken branch. Byte-identical determinism holds.
const GUARDED_ADOPT = {
  name: "adopt",
  nodes: [
    { id: "bump", kind: "agent", agent: { jobType: "senior:feature" }, emits: [{ name: "result", type: "string" }] },
    { id: "migrate", kind: "agent", agent: { jobType: "senior:migrate" } },
    { id: "release", kind: "connector", connector: { target: "npm:publish" } },
  ],
  edges: [
    { from: "bump", to: "migrate", when: "bump.result", equals: "breaking" },
    { from: "bump", to: "release", default: true },
    { from: "migrate", to: "release" },
  ],
};

test("S7 compiler: a guarded fan-out compiles to an exclusiveGateway with a FEEL condition + a default flow", async () => {
  const r = await compileOk(GUARDED_ADOPT);
  // The split's fork gateway is an EXCLUSIVE gateway (gwx), not the parallel fork (gwf).
  assert(/<bpmn:exclusiveGateway id="gwx0"[^>]*name="fan out of bump"/.test(r.bpmn), "guarded split forks on an exclusiveGateway");
  assert(!/<bpmn:parallelGateway id="gwf/.test(r.bpmn), "no parallel fork is emitted for a guarded split");
  // The breaking flow carries a FEEL equality condition comparing the producer's published fact var.
  // FEEL string literals in a conditionExpression use LITERAL double-quotes (the authored-BPMN
  // convention), so the guard survives the engine deploy path.
  assert(
    r.bpmn.includes('<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">=n0_result = "breaking"</bpmn:conditionExpression>'),
    `expected the breaking guard condition, got: ${r.bpmn.match(/<bpmn:conditionExpression[^<]*<\/bpmn:conditionExpression>/g)?.join(" | ")}`,
  );
  // The gwx gateway names its default (else) flow, and that flow itself carries NO condition.
  const defMatch = r.bpmn.match(/<bpmn:exclusiveGateway id="gwx0" default="(f\d+)"/);
  assert(defMatch, "the exclusive split names a default flow");
  const defFlow = new RegExp(`<bpmn:sequenceFlow id="${defMatch![1]}"[^>]*/>`);
  assert(defFlow.test(r.bpmn), "the default flow is unconditional (self-closing, no conditionExpression)");
});

test("S7 compiler: the branches re-converge on an EXCLUSIVE merge, not a parallel AND-join", async () => {
  const r = await compileOk(GUARDED_ADOPT);
  assert(/<bpmn:exclusiveGateway id="gwm0"[^>]*name="join into release"/.test(r.bpmn), "release merges on an exclusiveGateway (gwm)");
  assert(!/<bpmn:parallelGateway id="gwj/.test(r.bpmn), "no parallel AND-join is emitted for the exclusive re-convergence");
  // The resolved preview carries the guard fields on the edges.
  const guarded = r.resolved.edges.find((e) => e.to === "migrate" && e.fromNode === "bump");
  assertEquals(guarded?.when, "bump.result");
  assertEquals(guarded?.equals, "breaking");
  const dflt = r.resolved.edges.find((e) => e.to === "release" && e.fromNode === "bump");
  assertEquals(dflt?.default, true);
});

test("S7 compiler: multiple mutually-exclusive leaves join End on an exclusive merge (gwm_end)", async () => {
  // Mode D: `adopt` routes the missing outcome to an escalate (human) leaf and the default to a `done`
  // leaf. Only one leaf fires, so End must be an EXCLUSIVE merge, else the parallel join deadlocks.
  const r = await compileOk({
    name: "surface",
    nodes: [
      { id: "adopt", kind: "agent", agent: { jobType: "j" }, emits: [{ name: "surface", type: "string" }] },
      { id: "escalate", kind: "human", human: { prompt: "file upstream issue" } },
      { id: "done", kind: "connector", connector: { target: "npm:install" } },
    ],
    edges: [
      { from: "adopt", to: "escalate", when: "adopt.surface", equals: "missing" },
      { from: "adopt", to: "done", default: true },
    ],
  });
  assert(r.bpmn.includes('id="gwm_end"'), "the exclusive-branch leaves join End on an exclusive merge");
  assert(!r.bpmn.includes('id="gwj_end"'), "no parallel End join for mutually-exclusive leaves");
});

test("S7 compiler: byte-identical determinism holds for a guarded graph (input order irrelevant)", async () => {
  const a = await compileOk(GUARDED_ADOPT);
  const b = await compileOk({ ...GUARDED_ADOPT, nodes: [...GUARDED_ADOPT.nodes].reverse(), edges: [...GUARDED_ADOPT.edges].reverse() });
  assertEquals(a.bpmn, b.bpmn);
  assertEquals(a.diagram, b.diagram);
  assertEquals(JSON.stringify(a.resolved), JSON.stringify(b.resolved));
});

test("S7 compiler: a non-exhaustive guarded split is rejected before compilation", async () => {
  const errors = await compileFail({
    nodes: [
      { id: "bump", kind: "agent", agent: { jobType: "j" }, emits: [{ name: "result", type: "string" }] },
      { id: "migrate", kind: "agent", agent: { jobType: "j" } },
    ],
    edges: [{ from: "bump", to: "migrate", when: "bump.result", equals: "breaking" }],
  });
  assert(errors.length > 0, "a non-exhaustive guarded split does not compile");
});

test("S7 compiler: a post-merge node with an extra always-firing producer joins on a PARALLEL gateway, not an exclusive merge", async () => {
  // Regression (PR #495 review): `analyzeExclusiveTopology` marks EVERY node reachable from >=2 branch
  // targets of a split as a merge node — including nodes DOWNSTREAM of the first re-convergence. Here
  // `bump` splits to `migrate`/`release`, both re-converge on `release` (the real exclusive merge), and
  // `release` -> `finalize`. `finalize` ALSO has an independent always-firing producer `warmup`, so its
  // producers {release, warmup} are BOTH unconditional — the validator treats it as a parallel join.
  // Deriving `joinExclusive` from `mergeNodes` alone wrongly made `finalize` an exclusive merge
  // (first-token-proceeds), drifting from the validator. It must be a PARALLEL AND-join.
  const r = await compileOk({
    name: "postmerge",
    nodes: [
      { id: "bump", kind: "agent", agent: { jobType: "j" }, emits: [{ name: "result", type: "string" }] },
      { id: "warmup", kind: "connector", connector: { target: "npm:install" } },
      { id: "migrate", kind: "agent", agent: { jobType: "j" } },
      { id: "release", kind: "connector", connector: { target: "npm:publish" } },
      { id: "finalize", kind: "connector", connector: { target: "npm:pack" } },
    ],
    edges: [
      { from: "bump", to: "migrate", when: "bump.result", equals: "breaking" },
      { from: "bump", to: "release", default: true },
      { from: "migrate", to: "release" },
      { from: "release", to: "finalize" },
      { from: "warmup", to: "finalize" },
    ],
  });
  // `release` is the genuine exclusive merge of the split's two branches.
  assert(/<bpmn:exclusiveGateway id="gwm0"[^>]*name="join into release"/.test(r.bpmn), "release merges its split branches on an exclusive gateway");
  // `finalize` joins two always-firing producers — it MUST be a parallel AND-join, never an exclusive merge.
  assert(/<bpmn:parallelGateway id="gwj\d+"[^>]*name="join into finalize"/.test(r.bpmn), "finalize joins its always-firing producers on a parallel gateway");
  assert(!/<bpmn:exclusiveGateway id="gwm\d+"[^>]*name="join into finalize"/.test(r.bpmn), "finalize is NOT compiled as an exclusive merge");
});

test("a wait node's onTimeout: continue proceeds past the gate with NO escalation task; escalate (default) keeps the human stop (#462)", async () => {
  // AC (#462): `onTimeout: continue` routes the not-ready-at-boundary branch straight to the node end
  // — no `__esc` escalation user task, no human stop — while the default (`escalate`) parks it on the
  // escalation task. Two sibling wait nodes, one of each, isolate the difference.
  const graph = {
    name: "continue vs escalate",
    nodes: [
      { id: "soft", kind: "wait", wait: { kind: "pr", target: "acme/repo#1", match: { prState: "merged" }, onTimeout: "continue" } },
      { id: "hard", kind: "wait", wait: { kind: "pr", target: "acme/repo#2", match: { prState: "merged" }, onTimeout: "escalate" } },
    ],
    edges: [{ from: "soft", to: "hard" }],
  };
  const r = await compileOk(graph);
  const softEl = elementForNode(r.bpmn, "soft");
  const hardEl = elementForNode(r.bpmn, "hard");
  // continue: no escalation twin for `soft`, and its not-ready boundary flow lands on the node end.
  assert(!r.bpmn.includes(`delivery-human-task__${softEl}__esc`), "continue emits no escalation user task");
  assert(
    r.bpmn.includes(`<bpmn:sequenceFlow id="${softEl}_i4" name="not ready" sourceRef="${softEl}_lastGw" targetRef="${softEl}_end" />`),
    "continue routes the not-ready boundary branch to the node end",
  );
  // escalate: `hard` keeps its escalation twin and routes not-ready to it.
  assert(r.bpmn.includes(`delivery-human-task__${hardEl}__esc`), "escalate keeps the escalation user task");
  assert(
    r.bpmn.includes(`<bpmn:sequenceFlow id="${hardEl}_i4" name="not ready" sourceRef="${hardEl}_lastGw" targetRef="delivery-human-task__${hardEl}__esc" />`),
    "escalate routes the not-ready boundary branch to the escalation task",
  );
});

test("a wait node's onTimeout: fail is rejected at compile with a path-qualified error (blocked on engine terminate-end, #462/#978)", async () => {
  const errors = await compileFail({
    name: "fail not yet supported",
    nodes: [
      { id: "g", kind: "wait", wait: { kind: "pr", target: "acme/repo#1", match: { prState: "merged" }, onTimeout: "fail" } },
    ],
    edges: [],
  });
  const hit = errors.find((e) => e.path === "nodes[0].wait.onTimeout");
  assert(hit, `expected a path-qualified onTimeout error, got ${JSON.stringify(errors)}`);
  assert(hit?.message.includes("#978"), `the error names the blocking engine issue, got ${hit?.message}`);
});
