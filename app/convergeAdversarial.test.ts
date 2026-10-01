// Behavioural coverage for the local adversarial-review pass on the convergence loop's ADDRESSED
// path (issue #844, sub-issue of #842).
//
// Copilot had become our discovery loop: each finding costs a full GitHub re-review round, and many
// are the obvious "next" finding a second reader would catch locally. So an `addressed` round now
// runs a separate `senior:adversarial-review` agent BEFORE the round is persisted / parked on
// `waiting_review` (the only status the poller solicits a Copilot review for). Non-blank findings
// loop straight back into `review-round` (carrying `adversarialFindings`) — not through
// `capture-head`, so the round-entry head and the no-progress check still span the whole round.
// The pass count is BOUNDED per round by `advPass`/`advMax` and reset when a new review lands.
//
// These deploy the committed convergence-loop into the real WASM engine and drive tokens through it,
// asserting what the loop DOES (element run counts, job inputs, the parked wait), not how it is drawn.
import { after, test } from "node:test";
import { assert } from "#test-assert";
import { readFileSync } from "node:fs";
import { assertThatInstance, byProcessId, createWasmEngineClient, type WasmEngineClient } from "@nanobpm/urban-testkit";

const MODEL = readFileSync("resources/processes/convergence-loop.bpmn", "utf8");

type Output = Record<string, unknown>;
type Job = { variables: Record<string, unknown> };
type Responder = Output | Output[] | ((job: Job) => Output);

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

const FINDINGS = "Open: src/a.ts:10 fail-open on unknown input (high)";
const CLEAN = { adversarialFindings: "", adversarialSummary: "no findings" };

const DEFAULT_RESPONSES: Record<string, Responder> = {
  "senior:pr-review": { status: "addressed", summary: "fixed" },
  "senior:adversarial-review": CLEAN,
  "pr.capture-head": { roundEntryHead: "sha-entry" },
  "pr.persist-round": {},
  "pr.progress-check": { progressed: true },
  "pr.converge-gate": { convergeBlocked: false, convergeBlockReason: "", convergeAckOnly: false },
  "senior:scope-classify": { scopeBlocked: false, scopeBlockReason: "" },
  "pr.finalize": {},
  "pr.persist-escalation": { escalated: true },
  "pr.answer-escalation": {},
};

const DEFAULT_VARS: Record<string, unknown> = {
  prKey: "o/r#1",
  repo: "o/r",
  prNumber: 1,
  prUrl: "https://example.test/pr/1",
  round: 1,
  maxRounds: 20,
  reviewWaitTimeout: "PT30M",
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
};

const engines: WasmEngineClient[] = [];
after(async () => {
  await Promise.all(engines.map((e) => e.close()));
});

/** Boot the loop; records every job's input variables per job type for assertions. */
async function boot(opts: { responses?: Record<string, Responder>; vars?: Record<string, unknown> } = {}) {
  const engine = await createWasmEngineClient();
  engines.push(engine);
  await engine.deployResources([{ name: "convergence-loop.bpmn", content: MODEL, contentType: "text/xml" }]);
  const responses = { ...DEFAULT_RESPONSES, ...(opts.responses ?? {}) };
  const seen: Record<string, Record<string, unknown>[]> = {};
  for (const jobType of ALL_JOB_TYPES) {
    const responder = responses[jobType];
    const queue = Array.isArray(responder) ? [...responder] : null;
    seen[jobType] = [];
    await engine.registerWorker(jobType, (job) => {
      seen[jobType].push({ ...(job as Job).variables });
      if (queue) return queue.length > 1 ? queue.shift()! : (queue[0] ?? {});
      if (typeof responder === "function") return responder(job as Job);
      return responder ?? {};
    });
  }
  await engine.createInstance({
    processDefinitionId: "convergence-loop",
    awaitCompletion: false,
    variables: { ...DEFAULT_VARS, ...(opts.vars ?? {}) },
  });
  return { engine, seen };
}

function completions(engine: WasmEngineClient, elementId: string): number {
  const snap = engine.snapshot() as { elementStats?: { elementId: string; completed: number }[] };
  return (snap.elementStats ?? []).find((s) => s.elementId === elementId)?.completed ?? 0;
}
function instanceVars(engine: WasmEngineClient): Record<string, unknown> {
  const snap = engine.snapshot() as { instances?: { variables?: Record<string, unknown> }[] };
  return snap.instances?.[0]?.variables ?? {};
}
function runs(engine: WasmEngineClient): string {
  return ["review-round", "adversarial-review", "persist-round", "check-progress"]
    .map((id) => `${id}=${completions(engine, id)}`)
    .join(" ");
}

test("addressed + adversarial findings loop back into review-round with the findings, then park for Copilot", async () => {
  const { engine, seen } = await boot({
    responses: { "senior:adversarial-review": [{ adversarialFindings: FINDINGS, adversarialSummary: "1 finding" }, CLEAN] },
    vars: { advMax: 2 },
  });
  assertThatInstance(engine, byProcessId("convergence-loop")).isActive().hasNoIncident();
  assert(completions(engine, "review-round") === 2, `review-round should run twice: ${runs(engine)}`);
  assert(completions(engine, "adversarial-review") === 2, `adversarial-review should run twice: ${runs(engine)}`);
  // The round is persisted and progress-checked ONCE, only after the adversarial pass came back clean.
  assert(completions(engine, "persist-round") === 1, `persist-round once: ${runs(engine)}`);
  assert(completions(engine, "check-progress") === 1, `check-progress once: ${runs(engine)}`);
  // The loop goes straight back to review-round, not through capture-head (round-entry head kept).
  assert(completions(engine, "capture-head") === 1, "the findings loop must not re-capture the round-entry head");
  const reviewJobs = seen["senior:pr-review"];
  assert(!reviewJobs[0].adversarialFindings, "the first review-round has no adversarial findings");
  assert(reviewJobs[1].adversarialFindings === FINDINGS, "the re-dispatched review-round receives the findings");
  // Parked on the Copilot review wait (the poller solicits only after progress-check parks it).
  assert(completions(engine, "wait-review") === 0, "must be parked waiting for the review");
});

test("a clean adversarial pass proceeds straight to persist-round", async () => {
  const { engine } = await boot();
  assertThatInstance(engine, byProcessId("convergence-loop")).isActive().hasNoIncident();
  assert(completions(engine, "review-round") === 1, runs(engine));
  assert(completions(engine, "adversarial-review") === 1, runs(engine));
  assert(completions(engine, "persist-round") === 1, runs(engine));
});

test("the adversarial pass is bounded by advMax per round", async () => {
  const { engine } = await boot({
    responses: { "senior:adversarial-review": { adversarialFindings: FINDINGS, adversarialSummary: "always" } },
    vars: { advMax: 2 },
  });
  assertThatInstance(engine, byProcessId("convergence-loop")).isActive().hasNoIncident();
  assert(completions(engine, "adversarial-review") === 2, `cap of 2 passes: ${runs(engine)}`);
  // 1 initial + 2 findings loops = 3 review-rounds, then the round proceeds despite findings.
  assert(completions(engine, "review-round") === 3, runs(engine));
  assert(completions(engine, "persist-round") === 1, runs(engine));
});

test("advMax=0 disables the adversarial pass", async () => {
  const { engine } = await boot({ vars: { advMax: 0 } });
  assertThatInstance(engine, byProcessId("convergence-loop")).isActive().hasNoIncident();
  assert(completions(engine, "adversarial-review") === 0, runs(engine));
  assert(completions(engine, "persist-round") === 1, runs(engine));
});

test("an instance seeded without advPass/advMax (pre-#844 shape) skips the pass, no incident", async () => {
  const { engine } = await boot({ vars: { advPass: null, advMax: null } });
  assertThatInstance(engine, byProcessId("convergence-loop")).isActive().hasNoIncident();
  assert(completions(engine, "adversarial-review") === 0, runs(engine));
  assert(completions(engine, "persist-round") === 1, runs(engine));
});

test("a waiting round (no review yet) does not run the adversarial pass", async () => {
  const { engine } = await boot({ responses: { "senior:pr-review": { status: "waiting", summary: "no review" } } });
  assertThatInstance(engine, byProcessId("convergence-loop")).isActive().hasNoIncident();
  assert(completions(engine, "adversarial-review") === 0, runs(engine));
});

test("a converged round does not run the adversarial pass", async () => {
  const { engine } = await boot({ responses: { "senior:pr-review": { status: "converged", summary: "done" } } });
  assertThatInstance(engine, byProcessId("convergence-loop")).hasCompleted().hasNoIncident();
  assert(completions(engine, "adversarial-review") === 0, runs(engine));
});

test("the pass budget resets when the next review lands (new round)", async () => {
  const { engine } = await boot({
    responses: { "senior:adversarial-review": { adversarialFindings: FINDINGS, adversarialSummary: "always" } },
    vars: { advMax: 1 },
  });
  assert(completions(engine, "adversarial-review") === 1, runs(engine));
  assert(instanceVars(engine).advPass === 1, `advPass after round 1: ${instanceVars(engine).advPass}`);
  await engine.publishMessage({ name: "readiness-ready", correlationKey: "o/r#1", variables: { ready: true } });
  assertThatInstance(engine, byProcessId("convergence-loop")).isActive().hasNoIncident();
  // Round 2 gets its own full budget of 1 pass.
  assert(completions(engine, "adversarial-review") === 2, `round 2 must get a fresh pass: ${runs(engine)}`);
});
