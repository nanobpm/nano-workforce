// Behavioural coverage for the convergence loop's AGENT-task liveness SLA (issue #849).
//
// An external agent task is a durable wait on an external actor: the worker keeps renewing the
// job's deadline for as long as the agent process is alive, so a hung or looping agent parks the
// token forever with no incident and no escalation (the nanobpm/nano-bpm#1308 incident:
// `classify-scope` ran 7h27m unbounded). Every external agent task in the loop — `review-round`,
// `adversarial-review`, and `classify-scope` — now carries an interrupting timer boundary whose
// `<bpmn:timeDuration>=agentSlaTimeout` is evaluated at timer creation; on expiry the token
// routes to the canonical `pr.persist-escalation` path and parks on the `wait-answer` user task.
//
// These deploy the committed convergence-loop into the real WASM engine (`@nanobpm/urban-testkit`),
// park the agent job (no worker completes it), advance the clock past `agentSlaTimeout`, and
// assert the instance leaves the task via the SLA flow into escalation — the observable
// behaviour, not the drawn shape (per the mergeLoopBehaviour.test.ts pattern).
import { after, test } from "node:test";
import { assert, assertStringIncludes } from "#test-assert";
import { readFileSync } from "node:fs";
import {
  assertThatInstance,
  assertThatUserTask,
  byProcessId,
  createWasmEngineClient,
  type WasmEngineClient,
} from "@nanobpm/urban-testkit";

const MODEL = readFileSync("resources/processes/convergence-loop.bpmn", "utf8");

const AGENT_SLA_MS = 30 * 60 * 1000; // matches the PT30M we start instances with

type Output = Record<string, unknown>;
type Job = { variables: Record<string, unknown> };
type Responder = Output | ((job: Job) => Output);

const ALL_JOB_TYPES = [
  "senior:pr-review",
  "senior:adversarial-review",
  "pr.capture-head",
  "pr.persist-round",
  "pr.progress-check",
  "pr.converge-gate",
  "senior:scope-classify",
  "pr.finalize",
  "pr.persist-escalation",
  "pr.answer-escalation",
] as const;

const DEFAULT_RESPONSES: Record<string, Responder> = {
  "senior:pr-review": { status: "addressed", summary: "fixed" },
  "senior:adversarial-review": { adversarialFindings: "", adversarialSummary: "no findings" },
  "pr.capture-head": { roundEntryHead: "sha-entry" },
  "pr.persist-round": {},
  "pr.progress-check": { progressed: true },
  "pr.converge-gate": { convergeBlocked: false, convergeBlockReason: "", convergeAckOnly: false },
  "senior:scope-classify": { scopeBlocked: false, scopeBlockReason: "" },
  "pr.finalize": {},
  "pr.persist-escalation": { escalated: true },
  "pr.answer-escalation": {},
};

// Every FEEL expression in the model references these; start them defined (null, or a typed zero
// where the model compares/arithmetics the value) so a missing-variable access can never raise a
// spurious incident in a test.
const DEFAULT_VARS: Record<string, unknown> = {
  prKey: "o/r#1",
  repo: "o/r",
  prNumber: 1,
  prUrl: "https://example.test/pr/1",
  round: 1,
  maxRounds: 20,
  reviewWaitTimeout: "PT30M",
  agentSlaTimeout: "PT30M",
  ackRetryRound: 0,
  ackRetryMax: 2,
  advPass: 0,
  advMax: 1,
  abandonBrief: null,
  status: null,
  question: null,
  summary: null,
  answer: null,
  scopePending: false,
  scopeAnswer: null,
  convergeBlocked: null,
  convergeBlockReason: null,
  convergeAckOnly: null,
  reviewStale: null,
  roundEntryHead: null,
  huskRetries: 0,
  progressed: true,
  escalated: null,
  humanApproval: false,
  mergeDecision: null,
};

const engines: WasmEngineClient[] = [];
after(async () => {
  await Promise.all(engines.map((e) => e.close()));
});

/**
 * Boot the loop wired to per-job-type responders. A job type mapped to `null` registers **no**
 * worker, so its token parks on the task — used to let an agent SLA boundary fire. The variables
 * the `pr.persist-escalation` worker is activated with are captured for the escalation-payload
 * assertions (its `question`/`status` are job-LOCAL input mappings, so they never surface as
 * instance variables).
 */
async function boot(opts: { responses?: Record<string, Responder | null>; vars?: Record<string, unknown> } = {}) {
  const engine = asReadModelApp(await createWasmEngineClient());
  engines.push(engine);
  await engine.deployResources([{ name: "convergence-loop.bpmn", content: MODEL, contentType: "text/xml" }]);
  const responses: Record<string, Responder | null> = { ...DEFAULT_RESPONSES, ...(opts.responses ?? {}) };
  let escalation: Record<string, unknown> = {};
  for (const jobType of ALL_JOB_TYPES) {
    const responder = jobType in responses ? responses[jobType] : undefined;
    if (responder === null) continue; // park the token (e.g. to let the SLA timer fire)
    await engine.registerWorker(jobType, (job) => {
      if (jobType === "pr.persist-escalation") {
        escalation = { ...(job as Job).variables };
      }
      if (typeof responder === "function") return responder(job as Job);
      return (responder as Output | undefined) ?? {};
    });
  }
  await engine.createInstance({
    processDefinitionId: "convergence-loop",
    awaitCompletion: false,
    variables: { ...DEFAULT_VARS, ...(opts.vars ?? {}) },
  });
  return { engine, escalation: () => escalation };
}

/**
 * urban-testkit's `assertThatUserTask` reads through a booted-app port (`app.engine.openUserTasks`).
 * These tests drive the WASM engine directly (no full app boot), so expose the client as its own
 * read-model app: `.engine` self-references so the task reads land on the same client.
 */
function asReadModelApp(engine: WasmEngineClient): WasmEngineClient {
  (engine as unknown as { engine: WasmEngineClient }).engine = engine;
  return engine;
}

/** Element ids completed by the single instance — mirrors the DSL's `completedElementIds`. */
function completedElementIds(engine: WasmEngineClient): Set<string> {
  const snap = engine.snapshot() as { elementStats?: { elementId: string; completed: number }[] };
  return new Set((snap.elementStats ?? []).filter((s) => s.completed > 0).map((s) => s.elementId));
}

/** Engine-global cumulative taken sequence flows as `from->to` pairs (single instance per engine
 * in these tests). The snapshot reports flows as `{from, to}` objects, not flow ids. */
function takenSequenceFlows(engine: WasmEngineClient): Set<string> {
  const snap = engine.snapshot() as { takenSequenceFlows?: unknown[] };
  const flows = Array.isArray(snap.takenSequenceFlows) ? snap.takenSequenceFlows : [];
  return new Set(
    flows
      .filter((f): f is { from: string; to: string } => typeof f === "object" && f !== null && "from" in f && "to" in f)
      .map((f) => `${f.from}->${f.to}`),
  );
}

test("a hung review-round agent escalates via its SLA boundary instead of parking forever", async () => {
  const { engine, escalation } = await boot({ responses: { "senior:pr-review": null } }); // park on the agent
  assertThatInstance(engine, byProcessId("convergence-loop")).isActive().hasActiveElement("review-round");
  await engine.advanceTime(AGENT_SLA_MS + 1);
  // The SLA boundary interrupted the stuck task and routed to the canonical escalation path.
  await assertThatUserTask(engine, { instance: byProcessId("convergence-loop"), elementId: "wait-answer" }).isCreated();
  assert(completedElementIds(engine).has("persist-escalation-reviewsla"), "the SLA flow must run the review-round agent-SLA escalation task");
  assert(takenSequenceFlows(engine).has("be_review_sla->persist-escalation-reviewsla"), "the token must leave review-round via its SLA flow");
  assertStringIncludes(String(escalation().question ?? ""), "review-round", "the escalation must name the wedged task");
  assertStringIncludes(String(escalation().question ?? ""), "SLA", "the escalation must name the SLA trigger");
});

test("a hung classify-scope agent escalates via its SLA boundary instead of parking 7h unbounded (#849)", async () => {
  // The classifier sits on the CONVERGED path; drive the loop there by answering the first
  // review round `converged` and parking ONLY the scope classifier.
  const { engine, escalation } = await boot({
    responses: { "senior:pr-review": { status: "converged", summary: "lgtm" }, "senior:scope-classify": null },
  });
  assertThatInstance(engine, byProcessId("convergence-loop")).isActive().hasActiveElement("classify-scope");
  await engine.advanceTime(AGENT_SLA_MS + 1);
  await assertThatUserTask(engine, { instance: byProcessId("convergence-loop"), elementId: "wait-answer" }).isCreated();
  assert(completedElementIds(engine).has("persist-escalation-scopesla"), "the SLA flow must run the classify-scope agent-SLA escalation task");
  assert(takenSequenceFlows(engine).has("be_scope_sla->persist-escalation-scopesla"), "the token must leave classify-scope via its SLA flow");
  assertStringIncludes(String(escalation().question ?? ""), "classify-scope", "the escalation must name the wedged task");
});

test("a hung adversarial-review agent escalates via its SLA boundary", async () => {
  const { engine, escalation } = await boot({ responses: { "senior:adversarial-review": null } });
  assertThatInstance(engine, byProcessId("convergence-loop")).isActive().hasActiveElement("adversarial-review");
  await engine.advanceTime(AGENT_SLA_MS + 1);
  await assertThatUserTask(engine, { instance: byProcessId("convergence-loop"), elementId: "wait-answer" }).isCreated();
  assert(completedElementIds(engine).has("persist-escalation-advsla"), "the SLA flow must run the adversarial-review agent-SLA escalation task");
  assert(takenSequenceFlows(engine).has("be_adv_sla->persist-escalation-advsla"), "the token must leave adversarial-review via its SLA flow");
  assertStringIncludes(String(escalation().question ?? ""), "adversarial-review", "the escalation must name the wedged task");
});

test("a responsive agent never fires the SLA boundary (no spurious escalation)", async () => {
  // Every worker answers promptly; the round parks on the review-wait event gateway. Advancing
  // the clock past the SLA must not escalate — the boundary only fires while a task is still
  // active — and the review-wait timeout arm (not an agent SLA) is the only timer that fires.
  const { engine } = await boot();
  assertThatInstance(engine, byProcessId("convergence-loop")).isActive().hasActiveElement("wait-review");
  await engine.advanceTime(AGENT_SLA_MS * 4);
  assert(!completedElementIds(engine).has("persist-escalation-reviewsla") &&
    !completedElementIds(engine).has("persist-escalation-advsla") &&
    !completedElementIds(engine).has("persist-escalation-scopesla"), "no agent-SLA escalation on a healthy run");
});
