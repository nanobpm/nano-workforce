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

    const run = await runDeliveryGraph(engine, MATRIX_GRAPH);
    assert(run.ok, `runDeliveryGraph failed: ${JSON.stringify(run)}`);
    const key = run.handle.processInstanceKey;

    // Drive to terminal: serve jobs (drain), then complete any parked human user task, repeat. No
    // virtual-clock advance — the happy path stalls ONLY on the human node, never on a timer.
    const humanTasks: string[] = [];
    let state = "?";
    for (let round = 0; round < MAX_ROUNDS; round++) {
      await engine.drain();
      const [pi] = await engine.searchProcessInstances({ processInstanceKeys: [key] });
      state = pi?.state ?? "?";
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
    const run = await runDeliveryGraph(engine, graph, { nodeTimeout: "PT1M", escalationSlaTimeout: "PT1H" });
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
      state = pi?.state ?? "?";
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
