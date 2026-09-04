// End-to-end coverage that the delivery-graph compiler (ADR 0005) emits BPMN that is BOTH
// EXECUTABLE and RENDERABLE — the two disjoint validity axes of the one BPMN in this system that is
// generated at RUNTIME by raw string concatenation rather than authored (issue #451).
//
// The pure compiler tests (`deliveryGraphCompiler.test.ts`) assert only on the XML STRING SHAPE
// (`includes(...)`, regex counts). A string-shape assert proves the text LOOKS right; it does NOT
// prove it DEPLOYS — a mis-wired boundary event, a flow to a dropped element, a bad `ioMapping`, or a
// `jobType` typo yields BPMN that passes every `includes()` and still fails `engine.deploy(xml)` with
// a misleading "unknown target element" at the flow (the AGENTS.md "it parsed but didn't execute"
// drift class). So here we DEPLOY the compiled graph through the real in-process WASM engine
// (`@nanobpm/urban-testkit`) via the SAME S4 path the runner uses (`runDeliveryGraph`) and ADVANCE a
// live instance to a terminal state — the exact deploy → instance → user-tasks → complete → terminal
// path that otherwise only gets hand-verified against a live node.
//
// Renderability and executability are DISJOINT (a graph can lay out perfectly and still fail deploy,
// and vice-versa), so `di coverage` guards the visual axis independently: every emitted flow node
// carries a `bpmndi:BPMNShape` and every sequence flow a `bpmndi:BPMNEdge`, so a future node kind
// cannot silently ship without a diagram (AGENTS.md: "BPMN Models need DI for rendering").
import { test } from "node:test";
import { createWasmEngineClient } from "@nanobpm/urban-testkit";
import { assert, assertEquals } from "#test-assert";
import { DELIVERY_CONNECTOR_TASK_TYPE } from "./deliveryConnector.ts";
import { compileDeliveryGraph } from "./deliveryGraphCompiler.ts";
import { runDeliveryGraph } from "./deliveryRunner.ts";
import { jobStream } from "./agentic/correlation.ts";
import {
  TRANSCRIPT_URL_BASE_VAR,
  TRANSCRIPT_URL_VAR,
  transcriptUrlBaseFor,
  transcriptUrlForJob,
} from "./agentic/transcript-url.ts";
import type { DeliveryGraph } from "../nano-generated/api-io.d.ts";

/** A graph exercising the full node-kind matrix: `agent` (a named `senior:*` job), `wait` (the
 *  `pr.readiness-probe` poll gate), `human` (a user task), and `connector` (the delivery-connector
 *  delegate). This is the ADR's motivating release runbook. */
const MATRIX_GRAPH: DeliveryGraph = {
  name: "release runbook",
  nodes: [
    { id: "impl", kind: "agent", agent: { jobType: "senior:feature", prompt: "un-draft + merge #B" } },
    { id: "watch", kind: "wait", wait: { kind: "pr", target: "owner/repo#42", match: { prState: "merged" } }, emits: [{ name: "mergedSha", type: "string" }] },
    { id: "publish", kind: "human", human: { prompt: "run the manual OTP publish" }, emits: [{ name: "resolvedArtifact", type: "artifact" }] },
    { id: "consume", kind: "connector", connector: { target: "npm:install", dedupeKey: "consume-1" } },
  ],
  edges: [
    { from: "impl", to: "watch" },
    { from: "watch.mergedSha", to: "publish" },
    { from: "publish.resolvedArtifact", to: "consume" },
  ],
};

/** The generic completion payload for a delivery user task. Satisfies BOTH the `human` node's output
 *  ioMapping (`value` → `humanEmitValue`, `resolvedArtifact` → `humanEmitArtifact`, `note` →
 *  `humanNote`) and the escalation task's generic form (`value` required, `note`). */
const HUMAN_PAYLOAD = { value: "done", note: "ok", resolvedArtifact: "@nanobpm/demo@1.0.0" };

/** Upper bound on drive rounds — a terminal graph settles in a handful; the cap turns a wiring bug
 *  (a node that never advances) into a loud failure instead of a hang. */
const MAX_ROUNDS = 16;

test("deploy+advance: a well-formed graph deploys through the real engine and every node kind advances to a COMPLETED instance", async () => {
  const engine = await createWasmEngineClient();
  try {
    // Serve every service node's job so each node completes NORMALLY (no boundary timeout fires): the
    // agent job, the readiness probe (return `ready: true` so the poll loop exits on its first pass),
    // and the connector delegate.
    await engine.registerWorker("senior:feature", async () => ({}));
    await engine.registerWorker("pr.readiness-probe", async () => ({ ready: true, mergedSha: "deadbeefcafe" }));
    await engine.registerWorker(DELIVERY_CONNECTOR_TASK_TYPE, async () => ({}));

    const run = await runDeliveryGraph(engine, MATRIX_GRAPH, { repoless: true });
    assert(run.ok, `runDeliveryGraph failed: ${JSON.stringify(run)}`);
    const key = run.handle.processInstanceKey;

    // Drive to terminal: serve jobs (drain), then complete any parked human user task, repeat. No
    // virtual-clock advance — the happy path stalls ONLY on the human node, never on a timer.
    const humanTasks: string[] = [];
    let state = "?";
    for (let round = 0; round < MAX_ROUNDS; round++) {
      await engine.drain();
      const [pi] = await engine.searchProcessInstances({ processInstanceKeys: [key] });
      assert(pi, `no process instance snapshot for ${key} — searchProcessInstances returned empty`);
      state = pi.state ?? "?";
      if (state === "COMPLETED" || state === "TERMINATED") break;
      const open = await engine.searchUserTasks({ processInstanceKey: key, state: "CREATED" });
      assert(open.length > 0, `instance is ${state} with no open user task — a service node never advanced`);
      for (const t of open) {
        humanTasks.push(t.elementId ?? "?");
        await engine.completeUserTask(t.userTaskKey, HUMAN_PAYLOAD);
      }
    }

    assertEquals(state, "COMPLETED", "the deployed delivery graph must run to a COMPLETED instance");
    // The ONE stop on the happy path is the `publish` human node; its compiled user-task element id is
    // `delivery-human-task__<element>`. Assert we actually surfaced (and completed) it — proof the
    // human node's user task deployed and is completable, not just that the instance ended.
    assertEquals(humanTasks.length, 1, `expected exactly one human user task, saw ${JSON.stringify(humanTasks)}`);
    assert(
      humanTasks[0].startsWith("delivery-human-task__") && !humanTasks[0].endsWith("__esc"),
      `expected a human node task, saw ${humanTasks[0]}`,
    );
  } finally {
    await engine.close();
  }
});

test("deploy+advance: a stalled service node escalates on its node-timeout boundary onto a human-completable task that advances the instance to COMPLETED", async () => {
  const engine = await createWasmEngineClient();
  try {
    // A minimal agent → human graph. We deliberately register NO `senior:feature` worker, so the agent
    // node stalls and MUST escalate on its `=nodeTimeout` boundary timer — the exact path a stuck node
    // takes on a live fleet (and the one hand-verified against merlin).
    const graph: DeliveryGraph = {
      name: "escalation graph",
      nodes: [
        { id: "impl", kind: "agent", agent: { jobType: "senior:feature", prompt: "do it" } },
        { id: "signoff", kind: "human", human: { prompt: "sign off" } },
      ],
      edges: [{ from: "impl", to: "signoff" }],
    };
    // Short node timeout so the boundary fires within one virtual-clock advance; a long SLA so the
    // human node's own escalation boundary never fires during the drive.
    const run = await runDeliveryGraph(engine, graph, { nodeTimeout: "PT1M", escalationSlaTimeout: "PT1H", repoless: true });
    assert(run.ok, `runDeliveryGraph failed: ${JSON.stringify(run)}`);
    const key = run.handle.processInstanceKey;

    // The stalled agent has NOT escalated yet: no user task before the timeout.
    await engine.drain();
    let open = await engine.searchUserTasks({ processInstanceKey: key, state: "CREATED" });
    assertEquals(open.length, 0, "the stalled agent must not surface a task before its node timeout");

    // Fire the PT1M node-timeout boundary → the agent node escalates onto its `__esc` user task.
    await engine.advanceTime(60_000);
    open = await engine.searchUserTasks({ processInstanceKey: key, state: "CREATED" });
    assertEquals(open.length, 1, "the node timeout must surface exactly one escalation user task");
    assert(open[0].elementId?.endsWith("__esc"), `expected an __esc escalation task, saw ${open[0].elementId}`);

    // Complete the escalation task → the agent node ends → the flow reaches the human node → complete
    // that → terminal.
    const completed: string[] = [];
    let state = "?";
    for (let round = 0; round < MAX_ROUNDS; round++) {
      await engine.drain();
      const [pi] = await engine.searchProcessInstances({ processInstanceKeys: [key] });
      assert(pi, `no process instance snapshot for ${key} — searchProcessInstances returned empty`);
      state = pi.state ?? "?";
      if (state === "COMPLETED" || state === "TERMINATED") break;
      const tasks = await engine.searchUserTasks({ processInstanceKey: key, state: "CREATED" });
      assert(tasks.length > 0, `instance is ${state} with no open task after escalation — a node never advanced`);
      for (const t of tasks) {
        completed.push(t.elementId ?? "?");
        await engine.completeUserTask(t.userTaskKey, HUMAN_PAYLOAD);
      }
    }

    assertEquals(state, "COMPLETED", "completing the escalation + human task must run the graph to COMPLETED");
    assert(
      completed.some((id) => id.endsWith("__esc")),
      `the escalation task must have been driven, saw ${JSON.stringify(completed)}`,
    );
    assert(
      completed.some((id) => id.startsWith("delivery-human-task__") && !id.endsWith("__esc")),
      `the downstream human task must have been driven, saw ${JSON.stringify(completed)}`,
    );
  } finally {
    await engine.close();
  }
});

/** Every BPMN flow-node tag that must carry a `bpmndi:BPMNShape` to be rendered by human tooling. */
const FLOW_NODE_TAGS = [
  "startEvent",
  "endEvent",
  "task",
  "serviceTask",
  "userTask",
  "subProcess",
  "exclusiveGateway",
  "parallelGateway",
  "inclusiveGateway",
  "boundaryEvent",
  "intermediateCatchEvent",
  "intermediateThrowEvent",
  "callActivity",
].join("|");

/** Extract every `id="…"` for the given opening-tag alternation from the BPMN source. */
function idsForTags(bpmn: string, tagAlternation: string): string[] {
  const re = new RegExp(`<bpmn:(?:${tagAlternation})\\b[^>]*\\bid="([^"]+)"`, "g");
  return [...bpmn.matchAll(re)].map((m) => m[1]);
}

test("di coverage: every compiled flow node carries a BPMNShape and every sequence flow a BPMNEdge", async () => {
  const r = await compileDeliveryGraph(MATRIX_GRAPH);
  assert(r.ok, `expected ok:true, got ${JSON.stringify(r)}`);
  const bpmn = r.bpmn;

  const flowNodeIds = idsForTags(bpmn, FLOW_NODE_TAGS);
  assert(flowNodeIds.length > 0, "expected the compiled graph to contain flow nodes");
  const shapeless = flowNodeIds.filter(
    (id) => !new RegExp(`<bpmndi:BPMNShape[^>]*bpmnElement="${escapeRe(id)}"`).test(bpmn),
  );
  assertEquals(shapeless, [], `every flow node must have a BPMNShape; missing: ${JSON.stringify(shapeless)}`);

  const sequenceFlowIds = idsForTags(bpmn, "sequenceFlow");
  assert(sequenceFlowIds.length > 0, "expected the compiled graph to contain sequence flows");
  const edgeless = sequenceFlowIds.filter(
    (id) => !new RegExp(`<bpmndi:BPMNEdge[^>]*bpmnElement="${escapeRe(id)}"`).test(bpmn),
  );
  assertEquals(edgeless, [], `every sequence flow must have a BPMNEdge; missing: ${JSON.stringify(edgeless)}`);
});

/** Escape a BPMN element id for embedding in a RegExp (ids can contain `.` from fact-qualified names). */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Read a running process instance's scope variables out of the wasm engine's raw snapshot, by key. */
function instanceVariables(engine: { snapshot(): Record<string, unknown> }, key: string): Record<string, unknown> {
  const snap = engine.snapshot();
  const instances = snap.instances;
  assert(Array.isArray(instances), "snapshot.instances is an array of instance rows");
  const row = instances.find((i): i is { key: string; variables: Record<string, unknown> } => {
    return typeof i === "object" && i !== null && (i as { key?: unknown }).key === key;
  });
  assert(row !== undefined, `no snapshot instance row for ${key}`);
  return row.variables ?? {};
}

test("#543 transcript correlation: a completed agent job exposes a resolvable instance-scope transcriptUrl", async () => {
  const engine = await createWasmEngineClient();
  try {
    // A minimal agent→human graph: the agent job completes (emitting its transcript URL the way the
    // real fleet worker does — the seeded base + its own jobKey-scoped stream), then the instance parks
    // on the human node so its scope variables are still inspectable (a bare agent graph would COMPLETE
    // and drop them). The worker captures its jobKey so the test can assert the exact URL the SSOT
    // builder yields for it.
    let workerJobKey = "";
    let seededBase: unknown;
    await engine.registerWorker(
      "senior:feature",
      async (job) => {
        workerJobKey = String(job.jobKey);
        seededBase = job.variables?.transcriptUrlBase;
        // Mirror the harness: append the jobKey-scoped stream id to the app-seeded base (#486/#543).
        return { transcriptUrl: `${String(job.variables?.transcriptUrlBase)}${jobStream(workerJobKey)}` };
      },
      { fetchVariables: [TRANSCRIPT_URL_BASE_VAR] },
    );

    const graph: DeliveryGraph = {
      name: "transcript correlation",
      nodes: [
        { id: "impl", kind: "agent", agent: { jobType: "senior:feature", prompt: "ship it" } },
        { id: "review", kind: "human", human: { prompt: "review the run" } },
      ],
      edges: [{ from: "impl", to: "review" }],
    };
    const run = await runDeliveryGraph(engine, graph, { repoless: true });
    assert(run.ok, `runDeliveryGraph failed: ${JSON.stringify(run)}`);
    const key = run.handle.processInstanceKey;

    // Drive until the agent node has completed and the instance parks on the human user task.
    let parked = false;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      await engine.drain();
      const open = await engine.searchUserTasks({ processInstanceKey: key, state: "CREATED" });
      if (open.length > 0) {
        parked = true;
        break;
      }
    }
    assert(parked, "the agent node must complete and the instance park on the human node");

    // The app seeded the transcript endpoint base onto the agent job (input mapping)...
    assertEquals(seededBase, transcriptUrlBaseFor(), "the agent job receives the seeded transcriptUrlBase");
    // ...and the worker-emitted transcriptUrl propagated up to the process-instance scope (output
    // mapping), resolving to EXACTLY the SSOT URL for that jobKey — the link Nano Explorer renders.
    const vars = instanceVariables(engine, key);
    assertEquals(
      vars[TRANSCRIPT_URL_VAR],
      transcriptUrlForJob(workerJobKey),
      "the completed agent job exposes a resolvable, correct transcriptUrl on the instance",
    );
  } finally {
    await engine.close();
  }
});

// ── S7: guarded (conditional) routing DEPLOYS and ROUTES on the real engine (ADR 0005 S7) ──────────
// The compiler tests prove a guarded split emits an exclusiveGateway with FEEL conditions; only a live
// deploy proves the engine EVALUATES those conditions and takes exactly ONE branch. Here the `bump`
// agent's emitted scalar (`result`) is published to a process var and the exclusive gateway routes on
// it: the breaking outcome runs the `migrate` node, the green outcome skips straight to `release`, and
// BOTH re-converge on the exclusive merge to a COMPLETED instance (a parallel merge would deadlock the
// skipped branch). A guarded string fact needs a `default`, so green rides the else-flow.
const GUARDED_ADOPT: DeliveryGraph = {
  name: "adopt runbook",
  nodes: [
    { id: "bump", kind: "agent", agent: { jobType: "senior:bump" }, emits: [{ name: "result", type: "string" }] },
    { id: "migrate", kind: "agent", agent: { jobType: "senior:migrate" } },
    { id: "release", kind: "connector", connector: { target: "npm:publish", dedupeKey: "rel-1" } },
  ],
  edges: [
    { from: "bump", to: "migrate", when: "bump.result", equals: "breaking" },
    { from: "bump", to: "release", default: true },
    { from: "migrate", to: "release" },
  ],
};

async function driveGuarded(outcome: "breaking" | "green"): Promise<{ state: string; migrateRan: boolean; releaseRan: boolean }> {
  const engine = await createWasmEngineClient();
  try {
    let migrateRan = false;
    let releaseRan = false;
    // The split agent publishes its scalar outcome; the exclusive gateway routes on it.
    await engine.registerWorker("senior:bump", async () => ({ result: outcome }));
    await engine.registerWorker("senior:migrate", async () => {
      migrateRan = true;
      return {};
    });
    await engine.registerWorker(DELIVERY_CONNECTOR_TASK_TYPE, async () => {
      releaseRan = true;
      return {};
    });

    const run = await runDeliveryGraph(engine, GUARDED_ADOPT, { repoless: true });
    assert(run.ok, `runDeliveryGraph failed: ${JSON.stringify(run)}`);
    const key = run.handle.processInstanceKey;

    let state = "?";
    for (let round = 0; round < MAX_ROUNDS; round++) {
      await engine.drain();
      const [pi] = await engine.searchProcessInstances({ processInstanceKeys: [key] });
      assert(pi, `no process instance snapshot for ${key}`);
      state = pi.state ?? "?";
      if (state === "COMPLETED" || state === "TERMINATED") break;
    }
    return { state, migrateRan, releaseRan };
  } finally {
    await engine.close();
  }
}

test("S7 deploy+route: the breaking guard branch runs `migrate` before re-converging on the exclusive merge to COMPLETED", async () => {
  const r = await driveGuarded("breaking");
  assertEquals(r.state, "COMPLETED", "the breaking branch must run to a COMPLETED instance");
  assert(r.migrateRan, "the breaking outcome must route through the guarded `migrate` node");
  assert(r.releaseRan, "both branches must re-converge on `release`");
});

test("S7 deploy+route: the green default branch SKIPS `migrate` and rides the else-flow straight to COMPLETED", async () => {
  const r = await driveGuarded("green");
  assertEquals(r.state, "COMPLETED", "the green branch must run to a COMPLETED instance");
  assert(!r.migrateRan, "the green outcome must NOT route through `migrate` — it rides the default flow");
  assert(r.releaseRan, "the green outcome still reaches `release` via the else-flow (proof the exclusive merge fires on one token)");
});

// ── #506: the REAL agentic-worker classifier-emit contract drives a guarded split ──────────────────
// The S7 stubs above (`() => ({ result: outcome })`) prove the ENGINE routes on a published fact, but a
// bare `{ result }` is NOT what a real `senior:*` fleet agent returns — it completes with the whole
// Output-contract envelope (`{ status, summary, pr, … }`) and never a bare fact. So the gap #506 closes
// is: (a) the node's declared `emits` must be threaded into the agent's `appendPrompt` so a real agent
// is TOLD to surface the fact, and (b) the fact rides that SAME envelope as an extra top-level field.
// This graph proves both against the real engine: the `adopt` node declares `emits: [result]` and is
// serviced by a worker that (1) ASSERTS the emit contract reached it via `appendPrompt` — proving the
// runner actually delivers the instruction, not a test stub — and (2) returns the full envelope with the
// fact folded in, exactly as a contract-following agent would. Both branches are driven end to end.
const GUARDED_ADOPT_REAL: DeliveryGraph = {
  name: "adopt runbook (real agent)",
  nodes: [
    {
      id: "adopt",
      kind: "agent",
      agent: { jobType: "senior:feature", prompt: "Adopt the published package into this consumer and open a PR." },
      emits: [{ name: "result", type: "string", description: "breaking | compatible" }],
    },
    { id: "migrate", kind: "agent", agent: { jobType: "senior:migrate" } },
    { id: "release", kind: "connector", connector: { target: "npm:publish", dedupeKey: "rel-real-1" } },
  ],
  edges: [
    { from: "adopt", to: "migrate", when: "adopt.result", equals: "breaking" },
    { from: "adopt", to: "release", default: true },
    { from: "migrate", to: "release" },
  ],
};

/** Drive `GUARDED_ADOPT_REAL` with a worker that behaves like a REAL contract-following `senior:feature`
 *  agent: it reads the emit contract the runner threaded into its `appendPrompt`, then completes with the
 *  full Output-contract envelope carrying the classifier fact as a top-level field. Returns whether the
 *  contract actually reached the agent, plus which branches ran. */
async function driveGuardedRealAgent(outcome: "breaking" | "compatible"): Promise<{
  state: string;
  contractDelivered: boolean;
  factSurfaced: boolean;
  migrateRan: boolean;
  releaseRan: boolean;
}> {
  const engine = await createWasmEngineClient();
  try {
    let contractDelivered = false;
    let factSurfaced = false;
    let migrateRan = false;
    let releaseRan = false;

    await engine.registerWorker("senior:feature", async (job) => {
      const appendPrompt = String((job.variables as Record<string, unknown> | undefined)?.appendPrompt ?? "");
      // (a) The classifier emit contract MUST have reached the agent via its steering channel — this is
      //     the #506 fix (a plain `senior:feature` seed would carry no such instruction).
      contractDelivered =
        appendPrompt.includes("Classifier emit contract") &&
        appendPrompt.includes("`result`") &&
        appendPrompt.includes("AGENT_RESULT_FILE");
      factSurfaced = appendPrompt.includes("`result`");
      // (b) A real agent completes with the WHOLE Output-contract envelope, folding the declared fact in
      //     as an extra top-level field — NOT a bare `{ result }` stub.
      return { status: "opened", summary: `adopt done (${outcome})`, pr: "owner/repo#900", result: outcome };
    });
    await engine.registerWorker("senior:migrate", async () => {
      migrateRan = true;
      return { status: "opened", summary: "migrated", pr: "owner/repo#901" };
    });
    await engine.registerWorker(DELIVERY_CONNECTOR_TASK_TYPE, async () => {
      releaseRan = true;
      return {};
    });

    const run = await runDeliveryGraph(engine, GUARDED_ADOPT_REAL, { repoless: true });
    assert(run.ok, `runDeliveryGraph failed: ${JSON.stringify(run)}`);
    const key = run.handle.processInstanceKey;

    let state = "?";
    for (let round = 0; round < MAX_ROUNDS; round++) {
      await engine.drain();
      const [pi] = await engine.searchProcessInstances({ processInstanceKeys: [key] });
      assert(pi, `no process instance snapshot for ${key}`);
      state = pi.state ?? "?";
      if (state === "COMPLETED" || state === "TERMINATED") break;
    }
    return { state, contractDelivered, factSurfaced, migrateRan, releaseRan };
  } finally {
    await engine.close();
  }
}

test("#506 deploy+route: a REAL contract-following agent's envelope carries the classifier fact and routes the BREAKING branch through `migrate`", async () => {
  const r = await driveGuardedRealAgent("breaking");
  assert(r.contractDelivered, "the emit contract must reach the agent via its threaded appendPrompt (the #506 fix)");
  assert(r.factSurfaced, "the declared fact must be named to the agent");
  assertEquals(r.state, "COMPLETED", "the breaking branch must run to a COMPLETED instance");
  assert(r.migrateRan, "the breaking outcome (returned inside the real Output-contract envelope) must route through `migrate`");
  assert(r.releaseRan, "both branches must re-converge on `release`");
});

test("#506 deploy+route: the SAME real agent returning `compatible` in its envelope rides the default flow, SKIPPING `migrate`", async () => {
  const r = await driveGuardedRealAgent("compatible");
  assert(r.contractDelivered, "the emit contract must reach the agent via its threaded appendPrompt (the #506 fix)");
  assertEquals(r.state, "COMPLETED", "the compatible branch must run to a COMPLETED instance");
  assert(!r.migrateRan, "the compatible outcome must NOT route through `migrate` — the envelope's `result` rides the default flow");
  assert(r.releaseRan, "the compatible outcome still reaches `release` via the else-flow");
});

test("S7 deploy+route: mutually-exclusive leaves join End on an exclusive merge — the untaken leaf never blocks completion", async () => {
  // Mode D: `adopt` routes a missing surface to an escalate (human) leaf, else to a `done` connector
  // leaf. On the default path the escalate leaf never fires; an exclusive End merge must still let the
  // instance COMPLETE (a parallel End join would wait forever on the untaken human leaf).
  const graph: DeliveryGraph = {
    name: "surface check",
    nodes: [
      { id: "adopt", kind: "agent", agent: { jobType: "senior:adopt" }, emits: [{ name: "surface", type: "string" }] },
      { id: "escalate", kind: "human", human: { prompt: "file the upstream issue" } },
      { id: "done", kind: "connector", connector: { target: "npm:install", dedupeKey: "done-1" } },
    ],
    edges: [
      { from: "adopt", to: "escalate", when: "adopt.surface", equals: "missing" },
      { from: "adopt", to: "done", default: true },
    ],
  };

  // Default path (surface present): the human leaf is skipped and the instance COMPLETES on its own.
  {
    const engine = await createWasmEngineClient();
    try {
      let doneRan = false;
      await engine.registerWorker("senior:adopt", async () => ({ surface: "present" }));
      await engine.registerWorker(DELIVERY_CONNECTOR_TASK_TYPE, async () => {
        doneRan = true;
        return {};
      });
      const run = await runDeliveryGraph(engine, graph, { escalationSlaTimeout: "PT1H", repoless: true });
      assert(run.ok, `runDeliveryGraph failed: ${JSON.stringify(run)}`);
      const key = run.handle.processInstanceKey;
      let state = "?";
      for (let round = 0; round < MAX_ROUNDS; round++) {
        await engine.drain();
        const [pi] = await engine.searchProcessInstances({ processInstanceKeys: [key] });
        state = pi?.state ?? "?";
        if (state === "COMPLETED" || state === "TERMINATED") break;
        const open = await engine.searchUserTasks({ processInstanceKey: key, state: "CREATED" });
        assertEquals(open.length, 0, "the default path must never surface the escalate human leaf");
      }
      assertEquals(state, "COMPLETED", "the default (present) path completes without the human leaf");
      assert(doneRan, "the default path routes to the `done` connector leaf");
    } finally {
      await engine.close();
    }
  }

  // Guarded path (surface missing): the human leaf parks; `done` never runs.
  {
    const engine = await createWasmEngineClient();
    try {
      let doneRan = false;
      await engine.registerWorker("senior:adopt", async () => ({ surface: "missing" }));
      await engine.registerWorker(DELIVERY_CONNECTOR_TASK_TYPE, async () => {
        doneRan = true;
        return {};
      });
      const run = await runDeliveryGraph(engine, graph, { escalationSlaTimeout: "PT1H", repoless: true });
      assert(run.ok, `runDeliveryGraph failed: ${JSON.stringify(run)}`);
      const key = run.handle.processInstanceKey;
      let parked = "";
      for (let round = 0; round < MAX_ROUNDS; round++) {
        await engine.drain();
        const open = await engine.searchUserTasks({ processInstanceKey: key, state: "CREATED" });
        if (open.length > 0) {
          parked = open[0].elementId ?? "";
          break;
        }
      }
      assert(
        parked.startsWith("delivery-human-task__") && !parked.endsWith("__esc"),
        `the missing outcome must park on the escalate human leaf, saw ${JSON.stringify(parked)}`,
      );
      assert(!doneRan, "the guarded (missing) path must NOT run the `done` leaf");
    } finally {
      await engine.close();
    }
  }
});
