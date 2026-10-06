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
import { isDeliveryEscalationTwin } from "./deliveryHuman.ts";

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
      humanTasks[0].startsWith("delivery-human-task__") && !isDeliveryEscalationTwin(humanTasks[0]),
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
      completed.some((id) => id.startsWith("delivery-human-task__") && !isDeliveryEscalationTwin(id)),
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
        parked.startsWith("delivery-human-task__") && !isDeliveryEscalationTwin(parked),
        `the missing outcome must park on the escalate human leaf, saw ${JSON.stringify(parked)}`,
      );
      assert(!doneRan, "the guarded (missing) path must NOT run the `done` leaf");
    } finally {
      await engine.close();
    }
  }
});

// ── #863 deploy+route: a single-BOOLEAN human emit publishes a REAL FEEL boolean (not null) ─────────
// The compiler tests above assert only the SHAPE of the `coerceFactValueFeel` output string; they do
// NOT evaluate it, so they stayed green against a coercion defeated by a FEEL operator-precedence bug —
// `selectExpr` returns a BARE `if … then … else null` and the coercion embedded it as `rawExpr != null`,
// where FEEL's GREEDY `else` arm swallowed the `!= null and matches(…)` guard, collapsing the whole
// condition to the operator's raw entry and publishing NULL (adversarial finding, round 15; empirically
// `humanEmitValue`/`<el>_approval` came back null for `{approval:"true"}`). This drives it END TO END on
// the real engine: a human node emitting a single `boolean` feeds a guarded split comparing the fact
// `= true`; completing the task with the truthy text must publish a real `true` so the TRUE branch runs
// (a null-publishing coercion would route the `default` branch instead). Covers the bespoke
// (fact-named-field) AND generic (`value`-captured) forms — both go through the same coercion.
async function driveBooleanHumanGuard(opts: { bespoke: boolean; entry: Record<string, string>; emitName?: string }): Promise<{
  state: string;
  yesRan: boolean;
  noRan: boolean;
  task: string;
}> {
  const engine = await createWasmEngineClient();
  try {
    let yesRan = false;
    let noRan = false;
    await engine.registerWorker("senior:yes", async () => {
      yesRan = true;
      return {};
    });
    await engine.registerWorker("senior:no", async () => {
      noRan = true;
      return {};
    });
    const emitName = opts.emitName ?? "approval";
    const graph: DeliveryGraph = {
      name: "boolean human guard",
      nodes: [
        {
          id: "gate",
          kind: "human",
          human: opts.bespoke ? { prompt: "approve?", formKey: "bespoke-approval" } : { prompt: "approve?" },
          emits: [{ name: emitName, type: "boolean" }],
        },
        { id: "yes", kind: "agent", agent: { jobType: "senior:yes" } },
        { id: "no", kind: "agent", agent: { jobType: "senior:no" } },
      ],
      edges: [
        { from: "gate", to: "yes", when: `gate.${emitName}`, equals: true },
        { from: "gate", to: "no", default: true },
      ],
    };
    // A long SLA so the human node's escalation boundary never fires during the drive.
    const run = await runDeliveryGraph(engine, graph, { escalationSlaTimeout: "PT1H", repoless: true });
    assert(run.ok, `runDeliveryGraph failed: ${JSON.stringify(run)}`);
    const key = run.handle.processInstanceKey;

    let state = "?";
    let task = "";
    for (let round = 0; round < MAX_ROUNDS; round++) {
      await engine.drain();
      const [pi] = await engine.searchProcessInstances({ processInstanceKeys: [key] });
      assert(pi, `no process instance snapshot for ${key}`);
      state = pi.state ?? "?";
      if (state === "COMPLETED" || state === "TERMINATED") break;
      const open = await engine.searchUserTasks({ processInstanceKey: key, state: "CREATED" });
      assert(open.length > 0, `instance is ${state} with no open user task — the guarded split never advanced`);
      for (const t of open) {
        task = t.elementId ?? "?";
        await engine.completeUserTask(t.userTaskKey, opts.entry);
      }
    }
    return { state, yesRan, noRan, task };
  } finally {
    await engine.close();
  }
}

test("#863 deploy+route: a BESPOKE single-boolean human form publishes a REAL `true` (not null) so the `= true` guard routes the TRUE branch", async () => {
  // The bespoke form captures under the FACT's own name (`approval`), so the operator's entry arrives as
  // `{approval:"true"}`; the coercion must publish the boolean `true`, not null.
  const r = await driveBooleanHumanGuard({ bespoke: true, entry: { approval: "true" } });
  assert(r.task.startsWith("delivery-human-task__") && !isDeliveryEscalationTwin(r.task), `expected the human task, saw ${r.task}`);
  assertEquals(r.state, "COMPLETED", "the graph must run to a COMPLETED instance");
  assert(r.yesRan, "a truthy bespoke boolean entry must publish a real `true` so the `= true` guard routes the TRUE branch (a null-publishing coercion would take the default)");
  assert(!r.noRan, "the default branch must NOT run when the boolean coerces to true");
});

test("#863 deploy+route: a GENERIC single-boolean human form ALSO publishes a real `true` (class sweep — same coercion, `value`-captured)", async () => {
  // The generic form captures under the canonical `value` control, so the operator's entry arrives as
  // `{value:"true"}`; the SAME coercion path must still publish a real `true`.
  const r = await driveBooleanHumanGuard({ bespoke: false, entry: { value: "true" } });
  assertEquals(r.state, "COMPLETED", "the graph must run to a COMPLETED instance");
  assert(r.yesRan, "a truthy generic boolean entry must publish a real `true` so the `= true` guard routes the TRUE branch");
  assert(!r.noRan, "the default branch must NOT run when the boolean coerces to true");
});

// ── #863 deploy+route: a single-NUMBER human emit coerces END TO END without incidenting on a blank ──
// The compiler tests assert only the SHAPE of `coerceFactValueFeel`'s number arm
// (`number(trim(string(value)))`); they never EVALUATE it, so they stayed green against a FEEL hazard.
// Round 23 aligned the number bind with the gate's `trim(string(...))` normalization. But `trim` is NOT
// null-safe, and `operand != null` does NOT prove the operand is STRINGABLE: when the emit's name collides
// with a FEEL BUILTIN (`count`, `sum`, `min`, …), a BLANK human form leaves that variable unset, so the
// `if (is defined(count) and count != null) then count else …` selection operand resolves to the builtin
// FUNCTION (`is defined(count)` is true for the builtin, and the function ≠ null). `trim(string(<function>))`
// then THROWS (`trim: expected a string, got null`), raising an io-mapping INCIDENT that parks the instance
// ACTIVE instead of publishing null and completing (adversarial finding, round 23; the pre-regression
// `number(rawExpr)` folded the same builtin operand to null cleanly). The fix NULL-SAFES the bind with a
// `string(rawExpr) != null` guard that short-circuits the trim for any non-stringable operand. This drives
// the number coercion END TO END on the real engine for a reserved-name (`count`) blank entry (must publish
// null → the `= 42` guard takes the default) and a padded `" 42 "` entry (must coerce the trimmed text to
// the real number → the TRUE branch). Covers the bespoke (fact-named-field) AND generic (`value`-captured)
// forms — both go through the same coercion.
async function driveNumberHumanGuard(opts: { bespoke: boolean; entry: Record<string, string> }): Promise<{
  state: string;
  yesRan: boolean;
  noRan: boolean;
  task: string;
}> {
  const engine = await createWasmEngineClient();
  try {
    let yesRan = false;
    let noRan = false;
    await engine.registerWorker("senior:yes", async () => {
      yesRan = true;
      return {};
    });
    await engine.registerWorker("senior:no", async () => {
      noRan = true;
      return {};
    });
    const graph: DeliveryGraph = {
      name: "number human guard",
      nodes: [
        {
          id: "gate",
          kind: "human",
          human: opts.bespoke ? { prompt: "how many?", formKey: "bespoke-count" } : { prompt: "how many?" },
          emits: [{ name: "count", type: "number" }],
        },
        { id: "yes", kind: "agent", agent: { jobType: "senior:yes" } },
        { id: "no", kind: "agent", agent: { jobType: "senior:no" } },
      ],
      edges: [
        { from: "gate", to: "yes", when: "gate.count", equals: 42 },
        { from: "gate", to: "no", default: true },
      ],
    };
    const run = await runDeliveryGraph(engine, graph, { escalationSlaTimeout: "PT1H", repoless: true });
    assert(run.ok, `runDeliveryGraph failed: ${JSON.stringify(run)}`);
    const key = run.handle.processInstanceKey;

    let state = "?";
    let task = "";
    for (let round = 0; round < MAX_ROUNDS; round++) {
      await engine.drain();
      const [pi] = await engine.searchProcessInstances({ processInstanceKeys: [key] });
      assert(pi, `no process instance snapshot for ${key}`);
      state = pi.state ?? "?";
      if (state === "COMPLETED" || state === "TERMINATED") break;
      const open = await engine.searchUserTasks({ processInstanceKey: key, state: "CREATED" });
      // A blank-number io-mapping INCIDENT parks the instance ACTIVE with NO open user task — this is the
      // exact failure the null-unsafe `number(trim(string(null)))` produced, and this assert catches it.
      assert(open.length > 0, `instance is ${state} with no open user task — the number coercion incidented instead of publishing a value`);
      for (const t of open) {
        task = t.elementId ?? "?";
        await engine.completeUserTask(t.userTaskKey, opts.entry);
      }
    }
    return { state, yesRan, noRan, task };
  } finally {
    await engine.close();
  }
}

test("#863 deploy+route: a BESPOKE single-number human form with a FEEL-builtin name (`count`) completed BLANK publishes null and COMPLETES (no io-mapping incident)", async () => {
  // Value absent + a builtin name → the selection operand resolves to the `count` builtin FUNCTION, so the
  // coercion's then-arm must NOT evaluate `trim(string(<function>))` (which throws); the `string(rawExpr)
  // != null` guard short-circuits it, the instance publishes null and routes the default.
  const r = await driveNumberHumanGuard({ bespoke: true, entry: {} });
  assert(r.task.startsWith("delivery-human-task__") && !isDeliveryEscalationTwin(r.task), `expected the human task, saw ${r.task}`);
  assertEquals(r.state, "COMPLETED", "a blank bespoke number entry must publish null and run to a COMPLETED instance (not park on an io-mapping incident)");
  assert(!r.yesRan, "a blank number entry publishes null, so the `= 42` guard must NOT run the TRUE branch");
  assert(r.noRan, "a blank number entry publishes null, so the default branch runs");
});

test("#863 deploy+route: a GENERIC single-number human form completed BLANK ALSO publishes null and COMPLETES (class sweep)", async () => {
  const r = await driveNumberHumanGuard({ bespoke: false, entry: {} });
  assertEquals(r.state, "COMPLETED", "a blank generic number entry must publish null and run to a COMPLETED instance");
  assert(!r.yesRan, "a blank number entry publishes null, so the `= 42` guard must NOT run the TRUE branch");
  assert(r.noRan, "a blank number entry publishes null, so the default branch runs");
});

test("#863 deploy+route: a BESPOKE single-number human form coerces a PADDED `\" 42 \"` to the real number so the `= 42` guard routes TRUE", async () => {
  // The gate accepts `" 42 "` (it trims), so the coercion must parse the SAME trimmed text to 42 — a
  // bare `number(" 42 ")` would yield null and wrongly take the default, breaking "gate accepts ⇒ bind".
  const r = await driveNumberHumanGuard({ bespoke: true, entry: { count: " 42 " } });
  assertEquals(r.state, "COMPLETED", "the graph must run to a COMPLETED instance");
  assert(r.yesRan, "a padded `\" 42 \"` entry must coerce to the real number 42 so the `= 42` guard routes the TRUE branch");
  assert(!r.noRan, "the default branch must NOT run when the number coerces to 42");
});

test("#863 deploy+route: a BESPOKE single-boolean human form with a FEEL-builtin name (`count`) completed BLANK publishes null and COMPLETES (class sweep — same null-unsafe-normalization hazard as the number arm)", async () => {
  // The boolean arm shares the hazard: `lower case(trim(string(<count builtin>)))` throws on a blank
  // builtin-named emit. The `string(rawExpr) != null` guard short-circuits it, so the instance publishes
  // null (a blank is not `true`) and routes the default rather than parking on an io-mapping incident.
  const r = await driveBooleanHumanGuard({ bespoke: true, entry: {}, emitName: "count" });
  assert(r.task.startsWith("delivery-human-task__") && !isDeliveryEscalationTwin(r.task), `expected the human task, saw ${r.task}`);
  assertEquals(r.state, "COMPLETED", "a blank builtin-named boolean entry must publish null and run to a COMPLETED instance (not park on an io-mapping incident)");
  assert(!r.yesRan, "a blank boolean entry publishes null, so the `= true` guard must NOT run the TRUE branch");
  assert(r.noRan, "a blank boolean entry publishes null, so the default branch runs");
});

// ── #863 deploy+route: a TEXT (`string`) / `artifact` single emit named after a FEEL builtin ─────────
// The number/boolean coercers reject a non-stringable selection operand, but the TEXT types
// (`string`/`version`/`url`/`pr`) pass `selectExpr`'s result through verbatim and the artifact source is
// NEVER coerced. The builtin-shadow hazard is a blank explicit form whose fact name collides with a FEEL
// builtin: `is defined(count) and count != null` is TRUE for the `count` builtin FUNCTION, so the
// fact-named candidate `then count` selects a FUNCTION for those fact types. The fix guards that candidate
// in `selectExpr` with `string(<factName>) != null`, which folds a builtin to null at the selection step
// for EVERY fact type (Copilot review #863, "Guard fact names that shadow FEEL builtins").
//
// IMPORTANT — what gates a GUARD REGRESSION vs what these engine tests prove. On the pinned WASM engine a
// function-valued selection ALREADY folds to null before it is published (a FEEL variable binding cannot
// hold a function), so the engine-observable outcome — COMPLETED, default routing, AND the published
// `humanEmitValue`/`humanEmitArtifact` (null for a blank form) — is IDENTICAL with or without the guard.
// The red-before/green-after gate against removing the guard is therefore the COMPILER-level assertion in
// `deliveryGraphCompiler.test.ts` (it regex-matches `… and string(<fact>) != null …` in the generated
// FEEL and goes red the moment the guard is dropped). These end-to-end engine tests instead pin the
// observable PUBLISHED-value contract — a blank builtin-named emit publishes null (not a function, which
// would incident or corrupt the fact on an engine that did NOT fold), and the guard does NOT drop a real
// captured text value (`approved` still selects and routes TRUE). Both layers are needed: the compiler
// test locks the guard in, the engine test proves the guarded expression yields the intended value.
async function driveStringHumanGuard(opts: { entry: Record<string, string>; emitName: string }): Promise<{
  state: string;
  yesRan: boolean;
  noRan: boolean;
  task: string;
  published: unknown;
}> {
  const engine = await createWasmEngineClient();
  try {
    let yesRan = false;
    let noRan = false;
    // The selected value is published as `humanEmitValue` into process scope, so a downstream worker sees
    // it. Capture it from whichever branch runs and assert the PUBLISHED contract, not merely completion.
    let published: unknown = "<<never published>>";
    const capture = (job: { variables?: Record<string, unknown> }): void => {
      const v = (job.variables as Record<string, unknown> | undefined) ?? {};
      published = v.humanEmitValue ?? null;
    };
    await engine.registerWorker("senior:yes", async (job) => {
      yesRan = true;
      capture(job);
      return {};
    });
    await engine.registerWorker("senior:no", async (job) => {
      noRan = true;
      capture(job);
      return {};
    });
    const graph: DeliveryGraph = {
      name: "string human guard",
      nodes: [
        {
          id: "gate",
          kind: "human",
          human: { prompt: "which label?", formKey: "bespoke-label" },
          emits: [{ name: opts.emitName, type: "string" }],
        },
        { id: "yes", kind: "agent", agent: { jobType: "senior:yes" } },
        { id: "no", kind: "agent", agent: { jobType: "senior:no" } },
      ],
      edges: [
        { from: "gate", to: "yes", when: `gate.${opts.emitName}`, equals: "approved" },
        { from: "gate", to: "no", default: true },
      ],
    };
    const run = await runDeliveryGraph(engine, graph, { escalationSlaTimeout: "PT1H", repoless: true });
    assert(run.ok, `runDeliveryGraph failed: ${JSON.stringify(run)}`);
    const key = run.handle.processInstanceKey;

    let state = "?";
    let task = "";
    for (let round = 0; round < MAX_ROUNDS; round++) {
      await engine.drain();
      const [pi] = await engine.searchProcessInstances({ processInstanceKeys: [key] });
      assert(pi, `no process instance snapshot for ${key}`);
      state = pi.state ?? "?";
      if (state === "COMPLETED" || state === "TERMINATED") break;
      const open = await engine.searchUserTasks({ processInstanceKey: key, state: "CREATED" });
      // A builtin-shadow selection that publishes/incidents on the FUNCTION parks the instance ACTIVE with
      // no open user task — this assert catches that regression.
      assert(open.length > 0, `instance is ${state} with no open user task — the string selection incidented on a builtin-shadow operand`);
      for (const t of open) {
        task = t.elementId ?? "?";
        await engine.completeUserTask(t.userTaskKey, opts.entry);
      }
    }
    return { state, yesRan, noRan, task, published };
  } finally {
    await engine.close();
  }
}

test("#863 deploy+route: a BESPOKE single-STRING human form with a FEEL-builtin name (`count`) completed BLANK publishes null and COMPLETES (text types pass selection through — builtin-shadow class sweep)", async () => {
  // `string` is a pass-through type: `coerceFactValueFeel` does NOT re-guard it, so the only defence is
  // `selectExpr`'s `string(<factName>) != null` guard. A blank builtin-named explicit form must fold to
  // null (not select the `count` builtin FUNCTION) and route the default rather than incident.
  const r = await driveStringHumanGuard({ entry: {}, emitName: "count" });
  assert(r.task.startsWith("delivery-human-task__") && !isDeliveryEscalationTwin(r.task), `expected the human task, saw ${r.task}`);
  assertEquals(r.state, "COMPLETED", "a blank builtin-named string entry must publish null and run to a COMPLETED instance (not incident on the selected builtin function)");
  assertEquals(r.published, null, "a blank builtin-named string emit must PUBLISH null — never the selected `count` builtin function");
  assert(typeof r.published !== "function", "the published emit must never be a FEEL builtin function value");
  assert(!r.yesRan, "a blank string entry publishes null, so the `= \"approved\"` guard must NOT run the TRUE branch");
  assert(r.noRan, "a blank string entry publishes null, so the default branch runs");
});

test("#863 deploy+route: a BESPOKE single-STRING human form still selects a real captured value (`approved`) so the guard routes TRUE (the stringability guard does not drop legit text)", async () => {
  // The `string(<factName>) != null` guard must NOT reject a genuinely captured TEXT value — a real
  // `approved` entry stringifies to itself, so the fact-named candidate is still selected and the `=
  // "approved"` guard routes the TRUE branch.
  const r = await driveStringHumanGuard({ entry: { count: "approved" }, emitName: "count" });
  assertEquals(r.state, "COMPLETED", "the graph must run to a COMPLETED instance");
  assertEquals(r.published, "approved", "the guard must still PUBLISH the real captured `approved` text — `string(approved) != null` holds, so it is not dropped");
  assert(r.yesRan, "a real captured `approved` entry must still be selected so the `= \"approved\"` guard routes the TRUE branch");
  assert(!r.noRan, "the default branch must NOT run when the string selects `approved`");
});

test("#863 deploy+route: a BESPOKE single-ARTIFACT human form with a FEEL-builtin name (`count`) completed BLANK publishes null and COMPLETES (artifact source is never coerced — builtin-shadow class sweep)", async () => {
  // The artifact source (`selectExpr(\"resolvedArtifact\")`) is passed through with NO coercion, so a blank
  // builtin-named explicit form would publish the `count` builtin FUNCTION as `humanEmitArtifact` absent
  // the `string(<factName>) != null` guard. With the guard the fact-named candidate folds to null and the
  // instance completes instead of parking on an io-mapping incident.
  const engine = await createWasmEngineClient();
  try {
    let publishedArtifact: unknown = "<<never published>>";
    await engine.registerWorker("senior:sink", async (job) => {
      const v = (job.variables as Record<string, unknown> | undefined) ?? {};
      publishedArtifact = v.humanEmitArtifact ?? null;
      return {};
    });
    const graph: DeliveryGraph = {
      name: "artifact human guard",
      nodes: [
        {
          id: "gate",
          kind: "human",
          human: { prompt: "attach the artifact", formKey: "bespoke-artifact" },
          emits: [{ name: "count", type: "artifact" }],
        },
        { id: "sink", kind: "agent", agent: { jobType: "senior:sink" } },
      ],
      edges: [{ from: "gate", to: "sink" }],
    };
    const run = await runDeliveryGraph(engine, graph, { escalationSlaTimeout: "PT1H", repoless: true });
    assert(run.ok, `runDeliveryGraph failed: ${JSON.stringify(run)}`);
    const key = run.handle.processInstanceKey;
    let state = "?";
    let task = "";
    for (let round = 0; round < MAX_ROUNDS; round++) {
      await engine.drain();
      const [pi] = await engine.searchProcessInstances({ processInstanceKeys: [key] });
      assert(pi, `no process instance snapshot for ${key}`);
      state = pi.state ?? "?";
      if (state === "COMPLETED" || state === "TERMINATED") break;
      const open = await engine.searchUserTasks({ processInstanceKey: key, state: "CREATED" });
      assert(open.length > 0, `instance is ${state} with no open user task — the artifact selection incidented on a builtin-shadow operand`);
      for (const t of open) {
        task = t.elementId ?? "?";
        await engine.completeUserTask(t.userTaskKey, {});
      }
    }
    assert(task.startsWith("delivery-human-task__") && !isDeliveryEscalationTwin(task), `expected the human task, saw ${task}`);
    assertEquals(state, "COMPLETED", "a blank builtin-named artifact entry must publish null and run to a COMPLETED instance (not incident on the selected builtin function)");
    assertEquals(publishedArtifact, null, "a blank builtin-named artifact emit must PUBLISH null — never the selected `count` builtin function");
    assert(typeof publishedArtifact !== "function", "the published artifact must never be a FEEL builtin function value");
  } finally {
    await engine.close();
  }
});

// ── #863 review 5430718031 deploy+route: human single-emit VALIDATION (fail closed) end to end ────────
// The compiler tests above assert only the SHAPE of the validity gate (`matches(…)` in the generated
// FEEL); they never EVALUATE it. These drive the typed validation END TO END on the real engine: an
// INVALID entry (a malformed version, a non-`pkg@version` artifact) must publish null and route the
// DEFAULT branch (fail closed — the guarded split's `equals` never matches null), while a VALID entry
// publishes through and routes the guarded branch. This is the observable contract the "Previously
// missed" findings asked for: human-task fact/artifact values are validated before downstream
// publication, exactly like the escalation resume path.
async function driveTypedHumanGuard(opts: { emitName: string; emitType: "version" | "artifact"; entry: Record<string, string> }): Promise<{
  state: string;
  published: unknown;
}> {
  const engine = await createWasmEngineClient();
  try {
    let published: unknown = "<<never published>>";
    await engine.registerWorker("senior:sink", async (job) => {
      const v = (job.variables as Record<string, unknown> | undefined) ?? {};
      published = v.humanEmitValue ?? v.humanEmitArtifact ?? null;
      return {};
    });
    const graph: DeliveryGraph = {
      name: "typed human guard",
      nodes: [
        {
          id: "gate",
          kind: "human",
          human: { prompt: "enter", formKey: "bespoke-typed" },
          emits: [{ name: opts.emitName, type: opts.emitType }],
        },
        { id: "sink", kind: "agent", agent: { jobType: "senior:sink" } },
      ],
      edges: [{ from: "gate", to: "sink" }],
    };
    const run = await runDeliveryGraph(engine, graph, { escalationSlaTimeout: "PT1H", repoless: true });
    assert(run.ok, `runDeliveryGraph failed: ${JSON.stringify(run)}`);
    const key = run.handle.processInstanceKey;
    let state = "?";
    for (let round = 0; round < MAX_ROUNDS; round++) {
      await engine.drain();
      const [pi] = await engine.searchProcessInstances({ processInstanceKeys: [key] });
      assert(pi, `no process instance snapshot for ${key}`);
      state = pi.state ?? "?";
      if (state === "COMPLETED" || state === "TERMINATED") break;
      const open = await engine.searchUserTasks({ processInstanceKey: key, state: "CREATED" });
      assert(open.length > 0, `instance is ${state} with no open user task — the typed-validation guard incidented`);
      for (const t of open) {
        await engine.completeUserTask(t.userTaskKey, opts.entry);
      }
    }
    return { state, published };
  } finally {
    await engine.close();
  }
}

test("#863 review 5430718031 deploy+route: a single-VERSION human emit rejects a malformed version (publishes null) and accepts a valid one", async () => {
  // Invalid: `not-a-version` fails the `^v?\d[\w.+-]*$` grammar → publishes null (fail closed), COMPLETES.
  const bad = await driveTypedHumanGuard({ emitName: "ver", emitType: "version", entry: { ver: "not-a-version" } });
  assertEquals(bad.state, "COMPLETED", "an invalid version entry must still COMPLETE (fail closed to null, not incident)");
  assertEquals(bad.published, null, "an invalid version must publish null (validated fail-closed), not the malformed text");

  // Valid: `1.2.3` passes the grammar → publishes through verbatim.
  const good = await driveTypedHumanGuard({ emitName: "ver", emitType: "version", entry: { ver: "1.2.3" } });
  assertEquals(good.state, "COMPLETED", "a valid version entry must COMPLETE");
  assertEquals(good.published, "1.2.3", "a valid version must publish through verbatim");
});

test("#863 review 5430718031 deploy+route: a single-ARTIFACT human emit rejects a non-pkg@version handle (publishes null) and accepts a valid one", async () => {
  // Invalid: `not-an-artifact` fails the `^@?[^@\s]+@v?\d[\w.+-]*$` grammar → publishes null (fail closed).
  const bad = await driveTypedHumanGuard({ emitName: "release", emitType: "artifact", entry: { release: "not-an-artifact" } });
  assertEquals(bad.state, "COMPLETED", "an invalid artifact entry must still COMPLETE (fail closed to null, not incident)");
  assertEquals(bad.published, null, "an invalid artifact handle must publish null (validated fail-closed), not the malformed text");

  // Valid (scoped pkg@version): `@nanobpm/demo@1.0.0` passes the grammar → publishes through verbatim.
  const good = await driveTypedHumanGuard({ emitName: "release", emitType: "artifact", entry: { release: "@nanobpm/demo@1.0.0" } });
  assertEquals(good.state, "COMPLETED", "a valid artifact entry must COMPLETE");
  assertEquals(good.published, "@nanobpm/demo@1.0.0", "a valid (scoped) artifact handle must publish through verbatim");
});
