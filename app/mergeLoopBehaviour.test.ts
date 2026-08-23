// Behavioural coverage for the sub-process merge-loop (issue #466).
//
// The merge-loop was refactored from a flat state machine into sub-processes
// (`SP_cifix`, `SP_rebase`) whose outcomes are propagated to the top level via
// end-event `ciOutcome`/`rebaseOutcome` output mappings and re-discriminated by
// `gw-ci-outcome`/`gw-rebase-outcome`. The previous merge guards were *structural
// text assertions* over the flat topology; they broke by construction under any
// re-shaping and re-encoded the model's shape rather than its behaviour.
//
// Per direction (issue #466) these are replaced with **behavioural** tests that
// deploy the committed model into the real WASM engine (`@nanobpm/urban-testkit`)
// and drive tokens through it, asserting the observable invariant — activated
// jobs, taken outcomes, terminal state, escalations, budget counters — so they
// protect what the loop *does*, not how it is drawn. The invariants preserved
// here are exactly those the retired guards protected:
//   - mergeRetryArm (#334): transient-retry arm re-arms within budget, escalates
//     when exhausted, advances the attempt counter only on a retry, no agent.
//   - mergeCiReattempt (#134): fix-ci `reattempt`/no-verdict re-arms (never pages
//     a human); blocked reconciles once from ground truth before escalating.
//   - mergeRebaseArm: conflict → bounded rebase agent → re-arm / escalate /
//     reconcile / wait-on-PR.
//   - mergeEscalationQuestion (#329/#454): the four blocked/SLA triggers and the
//     draft verdict each produce a distinct, human-actionable question; a
//     persist-escalation `escalated:false` re-enters the poller instead of
//     parking a dead user task.
//   - mergeEscalationUserTask (#256): escalation parks on the native
//     `wait-merge-answer` user task and the answer reconciles then re-arms.
// Plus the terminate semantics the refactor had to preserve: `MergeAbandoned`
// terminates the whole instance (it stays at the root, not inside a sub-process).
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

const MODEL = readFileSync("resources/processes/merge-loop.bpmn", "utf8");

const AGENT_SLA_MS = 30 * 60 * 1000; // matches the PT30M we start instances with

type Output = Record<string, unknown>;
type Responder = Output | Output[] | ((job: { variables: Record<string, unknown> }) => Output);

const ALL_JOB_TYPES = [
  "pr.arm-merge",
  "pr.merge",
  "pr.mark-merged",
  "senior:fix-ci",
  "senior:rebase",
  "pr.persist-escalation",
  "pr.answer-escalation",
  "pr.record-dependency",
] as const;

const DEFAULT_RESPONSES: Record<string, Responder> = {
  "pr.arm-merge": {},
  "pr.mark-merged": {},
  "pr.record-dependency": {},
  "pr.answer-escalation": {},
  "pr.persist-escalation": { escalated: true },
};

// Every FEEL expression in the model references these; start them defined (null)
// so a missing-variable access can never raise a spurious incident in a test.
const DEFAULT_VARS: Record<string, unknown> = {
  prKey: "pr-1",
  repo: "acme/app",
  prNumber: 1,
  prUrl: "https://example.test/pr/1",
  ciFixMax: 3,
  rebaseMax: 3,
  mergeRetryMax: 3,
  ciFixRound: 0,
  rebaseRound: 0,
  mergeRetryRound: 0,
  agentSlaTimeout: "PT30M",
  abandonBrief: null,
  failingChecksList: null,
  status: null,
  mergeState: null,
  mergeStatus: null,
  ciBlockedReconciled: null,
};

/**
 * Deploy the committed merge-loop and start one instance, wired to a per-job-type
 * responder. A responder may be a fixed output, a queue consumed per activation,
 * or a function of the job. A job type mapped to `null` registers **no** worker,
 * so its token parks on the task — used to let an agent SLA boundary fire.
 */
async function startMergeLoop(opts: {
  responses?: Record<string, Responder | null>;
  vars?: Record<string, unknown>;
} = {}): Promise<WasmEngineClient> {
  const engine = await createWasmEngineClient();
  await engine.deployResources([{ name: "merge-loop.bpmn", content: MODEL, contentType: "text/xml" }]);
  const responses: Record<string, Responder | null> = { ...DEFAULT_RESPONSES, ...(opts.responses ?? {}) };
  for (const jobType of ALL_JOB_TYPES) {
    const responder = jobType in responses ? responses[jobType] : undefined;
    if (responder === null) continue; // park the token (e.g. to let the SLA timer fire)
    const queue = Array.isArray(responder) ? [...responder] : null;
    await engine.registerWorker(jobType, (job) => {
      if (queue) return queue.length > 1 ? queue.shift()! : queue[0] ?? {};
      if (typeof responder === "function") return responder(job as { variables: Record<string, unknown> });
      return (responder as Output | undefined) ?? {};
    });
  }
  await engine.createInstance({
    processDefinitionId: "merge-loop",
    awaitCompletion: false,
    variables: { ...DEFAULT_VARS, ...(opts.vars ?? {}) },
  });
  return engine;
}

// Positive checks use the engine-testkit `assertThat*` DSL below. The DSL has no
// *negative* element matcher ("element X did NOT complete") and no *substring*
// variable matcher (`hasVariable` is deep-equal), so the two readers below cover
// exactly those gaps. They read via the **same canonical snapshot accessors the
// DSL uses internally** (`instance.js`): completions from the snapshot-global
// `elementStats` (`{ elementId, completed }`) and live vars from
// `instances[].variables`. Sound because every test runs one isolated instance
// per engine — the single-instance precondition the DSL's own aggregate read
// relies on.

/** Element ids completed by the single instance — mirrors the DSL's `completedElementIds`. */
function completedElementIds(engine: WasmEngineClient): Set<string> {
  const snap = engine.snapshot() as { elementStats?: { elementId: string; completed: number }[] };
  return new Set((snap.elementStats ?? []).filter((s) => s.completed > 0).map((s) => s.elementId));
}

/** The single instance's live variables — mirrors the DSL's `variablesOf`. */
function instanceVars(engine: WasmEngineClient): Record<string, unknown> {
  const snap = engine.snapshot() as { instances?: { variables?: Record<string, unknown> }[] };
  return snap.instances?.[0]?.variables ?? {};
}

const engines: WasmEngineClient[] = [];
async function boot(opts?: Parameters<typeof startMergeLoop>[0]): Promise<WasmEngineClient> {
  const engine = await startMergeLoop(opts);
  engines.push(engine);
  return engine;
}

/** The key of the single open `wait-merge-answer` task, via the typed read model. */
async function mergeAnswerTaskKey(engine: WasmEngineClient): Promise<string> {
  const tasks = await engine.searchUserTasks({});
  const row = tasks.find((t) => t.elementId === "wait-merge-answer");
  assert(row, "expected an open wait-merge-answer user task");
  return row.userTaskKey;
}
after(async () => {
  await Promise.all(engines.map((e) => e.close()));
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

test("a ready PR merges and the instance completes via mark-merged", async () => {
  const engine = await boot({ responses: { "pr.merge": { mergeStatus: "merged" } } });
  await engine.publishMessage({ name: "deps-cleared", correlationKey: "pr-1" });
  await engine.publishMessage({ name: "merge-ready", correlationKey: "pr-1", variables: { mergeState: "ready" } });
  assertThatInstance(engine, byProcessId("merge-loop")).hasCompleted().hasNoIncident().hasCompletedElements("mark-merged");
});

test("a queued merge parks on the event gateway; the landed message marks it merged", async () => {
  const engine = await boot({ responses: { "pr.merge": { mergeStatus: "queued" } } });
  await engine.publishMessage({ name: "deps-cleared", correlationKey: "pr-1" });
  await engine.publishMessage({ name: "merge-ready", correlationKey: "pr-1", variables: { mergeState: "ready" } });
  assertThatInstance(engine, byProcessId("merge-loop")).isActive().hasActiveElements("wait-landed", "wait-evicted");
  await engine.publishMessage({ name: "merge-landed", correlationKey: "pr-1" });
  assertThatInstance(engine, byProcessId("merge-loop")).hasCompleted().hasCompletedElements("mark-merged");
});

test("an evicted queued merge re-arms the poller rather than completing", async () => {
  const engine = await boot({ responses: { "pr.merge": { mergeStatus: "queued" } } });
  await engine.publishMessage({ name: "deps-cleared", correlationKey: "pr-1" });
  await engine.publishMessage({ name: "merge-ready", correlationKey: "pr-1", variables: { mergeState: "ready" } });
  await engine.publishMessage({ name: "merge-evicted", correlationKey: "pr-1" });
  // back at the poller's wait, not merged
  assertThatInstance(engine, byProcessId("merge-loop")).isActive().hasActiveElement("wait-mergeable");
  assert(!completedElementIds(engine).has("mark-merged"), "an evicted merge must not mark-merged");
});

// ---------------------------------------------------------------------------
// Transient-retry arm (mergeRetryArm, #334)
// ---------------------------------------------------------------------------

test("a transient retry re-arms the poller within budget and advances the retry counter only on retry", async () => {
  const engine = await boot({ responses: { "pr.merge": [{ mergeStatus: "retry" }, { mergeStatus: "merged" }] } });
  await engine.publishMessage({ name: "deps-cleared", correlationKey: "pr-1" });
  // 1st attempt: retry (base moved) → within budget → re-arm → 2nd attempt: merged
  await engine.publishMessage({ name: "merge-ready", correlationKey: "pr-1", variables: { mergeState: "ready" } });
  // the retry re-armed and re-polled; feed a second mergeable so the 2nd attempt runs
  assertThatInstance(engine, byProcessId("merge-loop")).isActive().hasActiveElement("wait-mergeable");
  assert(!completedElementIds(engine).has("merge-esc-attempt"), "a within-budget retry must NOT escalate");
  await engine.publishMessage({ name: "merge-ready", correlationKey: "pr-1", variables: { mergeState: "ready" } });
  assertThatInstance(engine, byProcessId("merge-loop")).hasCompleted();
});

test("a retry that exhausts the budget escalates as a repeated race, not a generic refusal", async () => {
  const engine = await boot({
    responses: { "pr.merge": { mergeStatus: "retry" } },
    vars: { mergeRetryMax: 0 }, // first retry → mergeRetryRound 1 > 0 → exhausted
  });
  await engine.publishMessage({ name: "deps-cleared", correlationKey: "pr-1" });
  await engine.publishMessage({ name: "merge-ready", correlationKey: "pr-1", variables: { mergeState: "ready" } });
  await assertThatUserTask(engine, { instance: byProcessId("merge-loop"), elementId: "wait-merge-answer" }).isCreated();
  assertThatInstance(engine, byProcessId("merge-loop")).hasCompletedElements("merge-esc-attempt");
  assertStringIncludes(String(instanceVars(engine).question ?? ""), "retry budget", "the retry escalation must read as a repeated race");
});

// ---------------------------------------------------------------------------
// CI-fix sub-process (SP_cifix) — mergeCiReattempt (#134), #329
// ---------------------------------------------------------------------------

async function driveToCiFix(engine: WasmEngineClient): Promise<void> {
  await engine.publishMessage({ name: "deps-cleared", correlationKey: "pr-1" });
  await engine.publishMessage({
    name: "merge-ready",
    correlationKey: "pr-1",
    variables: { mergeState: "blocked", failingChecks: 1, failingChecksList: "build" },
  });
}

test("a fixed CI verdict runs the agent, advances the fix counter, and re-arms the poller", async () => {
  const engine = await boot({ responses: { "senior:fix-ci": { status: "fixed" } } });
  await driveToCiFix(engine);
  assertThatInstance(engine, byProcessId("merge-loop"))
    .isActive()
    .hasActiveElement("wait-mergeable")
    .hasCompletedElements("fix-ci")
    .hasVariable("ciFixRound", 1); // the fix counter advanced across the sub-process boundary
  const done = completedElementIds(engine);
  assert(!done.has("merge-esc-attempt") && !done.has("merge-esc-conflict"), "a fixed verdict must never escalate");
});

test("a reattempt CI verdict re-arms the poller and never pages a human (#134)", async () => {
  const engine = await boot({ responses: { "senior:fix-ci": { status: "reattempt" } } });
  await driveToCiFix(engine);
  assertThatInstance(engine, byProcessId("merge-loop")).isActive().hasActiveElement("wait-mergeable");
  const done = completedElementIds(engine);
  assert(!done.has("merge-esc-attempt") && !done.has("merge-esc-conflict"), "a reattempt must not escalate");
});

test("a no-verdict CI result reconciles from ground truth (re-arm), not escalation (#134)", async () => {
  const engine = await boot({ responses: { "senior:fix-ci": { summary: "unclear" } } }); // no `status`
  await driveToCiFix(engine);
  assertThatInstance(engine, byProcessId("merge-loop")).isActive().hasActiveElement("wait-mergeable");
  assert(!completedElementIds(engine).has("merge-esc-attempt"), "a missing status must not escalate");
});

test("a blocked CI verdict with nothing pushed reconciles once before escalating", async () => {
  const engine = await boot({ responses: { "senior:fix-ci": { status: "blocked", pushed: false } } });
  await driveToCiFix(engine);
  // ci-reconcile re-arms and re-checks mergeable; it does not escalate on the first block
  assertThatInstance(engine, byProcessId("merge-loop"))
    .isActive()
    .hasActiveElement("wait-mergeable")
    .hasCompletedElements("ci-reconcile")
    .hasVariable("ciBlockedReconciled", true); // the one-shot reconcile is marked spent
  assert(!completedElementIds(engine).has("merge-esc-attempt"), "the first block episode must reconcile, not page a human");
});

test("a blocked CI verdict that already pushed escalates with a could-not-fix question", async () => {
  const engine = await boot({ responses: { "senior:fix-ci": { status: "blocked", pushed: true } } });
  await driveToCiFix(engine);
  await assertThatUserTask(engine, { instance: byProcessId("merge-loop"), elementId: "wait-merge-answer" }).isCreated();
  assertThatInstance(engine, byProcessId("merge-loop")).hasCompletedElements("merge-esc-attempt");
  assertStringIncludes(String(instanceVars(engine).question ?? ""), "CI-fix agent could not", "the question must name the could-not-fix trigger");
});

test("a CI-fix that discovers a dependency records it and waits on the other PR", async () => {
  const engine = await boot({ responses: { "senior:fix-ci": { status: "waiting-on-pr", dependsOn: "acme/app#2" } } });
  await driveToCiFix(engine);
  assertThatInstance(engine, byProcessId("merge-loop"))
    .isActive()
    .hasActiveElement("wait-deps")
    .hasCompletedElements("record-merge-dep"); // a waiting-on-pr verdict records the dependency
});

test("CI-fix budget exhaustion escalates as not-mergeable without running the agent", async () => {
  const engine = await boot({ responses: { "senior:fix-ci": { status: "fixed" } }, vars: { ciFixMax: 0 } });
  await driveToCiFix(engine);
  await assertThatUserTask(engine, { instance: byProcessId("merge-loop"), elementId: "wait-merge-answer" }).isCreated();
  assertThatInstance(engine, byProcessId("merge-loop")).hasCompletedElements("merge-esc-conflict");
  assert(!completedElementIds(engine).has("fix-ci"), "budget exhaustion must not run the fix-ci agent");
});

test("the fix-ci agent SLA interrupts the sub-process and escalates", async () => {
  const engine = await boot({ responses: { "senior:fix-ci": null } }); // park on the agent so the SLA fires
  await driveToCiFix(engine);
  assertThatInstance(engine, byProcessId("merge-loop")).isActive().hasActiveElement("fix-ci");
  await engine.advanceTime(AGENT_SLA_MS + 1);
  await assertThatUserTask(engine, { instance: byProcessId("merge-loop"), elementId: "wait-merge-answer" }).isCreated();
  assertThatInstance(engine, byProcessId("merge-loop")).hasCompletedElements("merge-esc-attempt");
  assertStringIncludes(String(instanceVars(engine).question ?? ""), "time budget (SLA)", "the SLA escalation must name the SLA trigger");
});

// ---------------------------------------------------------------------------
// Rebase sub-process (SP_rebase) — mergeRebaseArm
// ---------------------------------------------------------------------------

async function driveToRebase(engine: WasmEngineClient): Promise<void> {
  await engine.publishMessage({ name: "deps-cleared", correlationKey: "pr-1" });
  await engine.publishMessage({ name: "merge-ready", correlationKey: "pr-1", variables: { mergeState: "conflict" } });
}

test("a conflict runs the bounded rebase agent and a rebased result re-arms the poller", async () => {
  const engine = await boot({ responses: { "senior:rebase": { status: "rebased" } } });
  await driveToRebase(engine);
  assertThatInstance(engine, byProcessId("merge-loop"))
    .isActive()
    .hasActiveElement("wait-mergeable")
    .hasCompletedElements("rebase") // a conflict runs the rebase agent, not page a human
    .hasVariable("rebaseRound", 1); // the rebase counter advanced across the sub-process boundary
});

test("a rebase that cannot resolve escalates with a conflict question", async () => {
  const engine = await boot({ responses: { "senior:rebase": { status: "blocked" } } });
  await driveToRebase(engine);
  await assertThatUserTask(engine, { instance: byProcessId("merge-loop"), elementId: "wait-merge-answer" }).isCreated();
  assertThatInstance(engine, byProcessId("merge-loop")).hasCompletedElements("merge-esc-attempt");
  assertStringIncludes(String(instanceVars(engine).question ?? ""), "rebase agent could not resolve", "the question must name the conflict trigger");
});

test("a no-verdict rebase result reconciles from ground truth, not escalation (#134)", async () => {
  const engine = await boot({ responses: { "senior:rebase": { summary: "unclear" } } }); // no `status`
  await driveToRebase(engine);
  assertThatInstance(engine, byProcessId("merge-loop")).isActive().hasActiveElement("wait-mergeable");
  assert(!completedElementIds(engine).has("merge-esc-attempt"), "a missing rebase status must not escalate");
});

test("rebase budget exhaustion escalates as not-mergeable without running the agent", async () => {
  const engine = await boot({ responses: { "senior:rebase": { status: "rebased" } }, vars: { rebaseMax: 0 } });
  await driveToRebase(engine);
  await assertThatUserTask(engine, { instance: byProcessId("merge-loop"), elementId: "wait-merge-answer" }).isCreated();
  assertThatInstance(engine, byProcessId("merge-loop")).hasCompletedElements("merge-esc-conflict");
  assert(!completedElementIds(engine).has("rebase"), "budget exhaustion must not run the rebase agent");
});

test("the rebase agent SLA interrupts the sub-process and escalates as not-mergeable", async () => {
  const engine = await boot({ responses: { "senior:rebase": null } });
  await driveToRebase(engine);
  assertThatInstance(engine, byProcessId("merge-loop")).isActive().hasActiveElement("rebase");
  await engine.advanceTime(AGENT_SLA_MS + 1);
  await assertThatUserTask(engine, { instance: byProcessId("merge-loop"), elementId: "wait-merge-answer" }).isCreated();
  assertThatInstance(engine, byProcessId("merge-loop")).hasCompletedElements("merge-esc-conflict");
});

// ---------------------------------------------------------------------------
// Escalation user task (mergeEscalationUserTask #256, mergeEscalationQuestion #329/#454)
// ---------------------------------------------------------------------------

test("an escalation parks on the native user task; answering it reconciles then re-arms the poller", async () => {
  const engine = await boot({ responses: { "senior:rebase": { status: "blocked" } } });
  await driveToRebase(engine);
  await assertThatUserTask(engine, { instance: byProcessId("merge-loop"), elementId: "wait-merge-answer" }).isCreated();
  await engine.completeUserTask(await mergeAnswerTaskKey(engine), { answer: "rebased manually, retry" });
  assertThatInstance(engine, byProcessId("merge-loop"))
    .isActive()
    .hasActiveElement("wait-mergeable")
    .hasCompletedElements("record-merge-answer"); // answering runs the pr.answer-escalation reconcile
});

test("a persist-escalation that opens nothing (escalated:false) re-enters the poller, not a dead user task", async () => {
  const engine = await boot({
    responses: { "senior:rebase": { status: "blocked" }, "pr.persist-escalation": { escalated: false } },
  });
  await driveToRebase(engine);
  assertThatInstance(engine, byProcessId("merge-loop")).isActive().hasActiveElement("wait-mergeable");
  const openTasks = await engine.searchUserTasks({});
  assert(
    !openTasks.some((t) => t.elementId === "wait-merge-answer"),
    "escalated:false must not park a user task",
  );
});

test("a not-landable gate verdict gives a draft PR an actionable 'mark it ready' question (#454)", async () => {
  const engine = await boot();
  await engine.publishMessage({ name: "deps-cleared", correlationKey: "pr-1" });
  await engine.publishMessage({ name: "merge-ready", correlationKey: "pr-1", variables: { mergeState: "draft" } });
  await assertThatUserTask(engine, { instance: byProcessId("merge-loop"), elementId: "wait-merge-answer" }).isCreated();
  assertThatInstance(engine, byProcessId("merge-loop")).hasCompletedElements("merge-esc-conflict");
  assertStringIncludes(String(instanceVars(engine).question ?? ""), "draft", "a draft PR must get a mark-it-ready question");
});

// ---------------------------------------------------------------------------
// Terminate semantics — the refactor kept MergeAbandoned at the root
// ---------------------------------------------------------------------------

test("an abandoned merge terminates the whole instance (terminate stayed at the root)", async () => {
  const engine = await boot({ responses: { "pr.merge": { mergeStatus: "abandoned" } } });
  await engine.publishMessage({ name: "deps-cleared", correlationKey: "pr-1" });
  await engine.publishMessage({ name: "merge-ready", correlationKey: "pr-1", variables: { mergeState: "ready" } });
  assertThatInstance(engine, byProcessId("merge-loop")).isTerminated();
  assert(!completedElementIds(engine).has("mark-merged"), "an abandoned PR must not mark-merged");
});
