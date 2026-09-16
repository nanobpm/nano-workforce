// Behavioural coverage for the bounded agent auto-ack step on the converge-gate-blocked path
// (issue #796).
//
// The converge-gate fails CLOSED and used to route EVERY block straight to the human `wait-answer`.
// But a block whose SOLE cause is unacknowledged Copilot *suppressed advisories* (no unresolved
// inline threads) is routine and recoverable: simply re-dispatching the review-round agent posts the
// missing `nano-ack:` threads and converges. Pulling a human in as the FIRST recovery — before any
// bounded agent retry — is the defect (#789/#1199 on merlin parked a human for exactly this).
//
// The fix models a bounded auto-ack retry (mirroring the merge loop's `gw-merge-retry`): an ack-only
// block re-enters `review-round` up to `ackRetryMax` times, advancing `ackRetryRound` on each
// ack-only block, and only escalates to the human when the block is NOT ack-only (an unresolved
// inline thread), the re-dispatched agent needs input, or the budget is exhausted.
//
// These deploy the committed convergence-loop into the real WASM engine (`@nanobpm/urban-testkit`)
// and drive tokens through it, asserting the observable invariant (completed elements, budget
// counter, terminal state, escalation user task) — protecting what the loop DOES, not how it is drawn.
import { after, test } from "node:test";
import { assert } from "#test-assert";
import { readFileSync } from "node:fs";
import { assertThatInstance, byProcessId, createWasmEngineClient, type WasmEngineClient } from "@nanobpm/urban-testkit";

const MODEL = readFileSync("resources/processes/convergence-loop.bpmn", "utf8");

type Output = Record<string, unknown>;
type Responder = Output | Output[] | ((job: { variables: Record<string, unknown> }) => Output);

const ALL_JOB_TYPES = [
  "senior:pr-review",
  "pr.persist-round",
  "pr.progress-check",
  "pr.converge-gate",
  "senior:scope-classify",
  "pr.finalize",
  "pr.persist-escalation",
  "pr.answer-escalation",
] as const;

const DEFAULT_RESPONSES: Record<string, Responder> = {
  "senior:pr-review": { status: "converged", summary: "done" },
  "pr.persist-round": {},
  "pr.progress-check": { progressed: true },
  "senior:scope-classify": { scopeBlocked: false, scopeBlockReason: "" },
  "pr.finalize": {},
  "pr.persist-escalation": { escalated: true },
  "pr.answer-escalation": {},
};

// Every FEEL expression the model touches, seeded so a missing-variable access can never raise a
// spurious incident. `ackRetryMax` is the budget under test; overridden per scenario.
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
  progressed: true,
  escalated: null,
};

async function startLoop(opts: {
  responses?: Record<string, Responder | null>;
  vars?: Record<string, unknown>;
} = {}): Promise<WasmEngineClient> {
  const engine = await createWasmEngineClient();
  await engine.deployResources([{ name: "convergence-loop.bpmn", content: MODEL, contentType: "text/xml" }]);
  const responses: Record<string, Responder | null> = { ...DEFAULT_RESPONSES, ...(opts.responses ?? {}) };
  for (const jobType of ALL_JOB_TYPES) {
    const responder = jobType in responses ? responses[jobType] : undefined;
    if (responder === null) continue; // park the token
    const queue = Array.isArray(responder) ? [...responder] : null;
    await engine.registerWorker(jobType, (job) => {
      if (queue) return queue.length > 1 ? queue.shift()! : (queue[0] ?? {});
      if (typeof responder === "function") return responder(job as { variables: Record<string, unknown> });
      return (responder as Output | undefined) ?? {};
    });
  }
  await engine.createInstance({
    processDefinitionId: "convergence-loop",
    awaitCompletion: false,
    variables: { ...DEFAULT_VARS, ...(opts.vars ?? {}) },
  });
  return engine;
}

/** Element ids completed by the single instance. */
function completedElementIds(engine: WasmEngineClient): Set<string> {
  const snap = engine.snapshot() as { elementStats?: { elementId: string; completed: number }[] };
  return new Set((snap.elementStats ?? []).filter((s) => s.completed > 0).map((s) => s.elementId));
}
/** The number of times an element completed (review-round runs multiple times across retries). */
function completions(engine: WasmEngineClient, elementId: string): number {
  const snap = engine.snapshot() as { elementStats?: { elementId: string; completed: number }[] };
  return (snap.elementStats ?? []).find((s) => s.elementId === elementId)?.completed ?? 0;
}
function instanceVars(engine: WasmEngineClient): Record<string, unknown> {
  const snap = engine.snapshot() as { instances?: { variables?: Record<string, unknown> }[] };
  return snap.instances?.[0]?.variables ?? {};
}

function asReadModelApp(engine: WasmEngineClient): WasmEngineClient {
  (engine as unknown as { engine: WasmEngineClient }).engine = engine;
  return engine;
}

const engines: WasmEngineClient[] = [];
async function boot(opts?: Parameters<typeof startLoop>[0]): Promise<WasmEngineClient> {
  const engine = asReadModelApp(await startLoop(opts));
  engines.push(engine);
  return engine;
}
after(async () => {
  await Promise.all(engines.map((e) => e.close()));
});

async function openWaitAnswer(engine: WasmEngineClient): Promise<boolean> {
  const tasks = await engine.searchUserTasks({});
  return tasks.some((t) => t.elementId === "wait-answer");
}

// ── Acceptance: an ack-only block auto-acks and converges WITHOUT a human ─────

test("an ack-only converge block re-dispatches the review-round agent and converges — no human", async () => {
  // First gate call: blocked SOLELY on unacked advisories (ack-only). After the review-round agent
  // is re-dispatched (auto-ack), the second gate call clears.
  const engine = await boot({
    responses: {
      "pr.converge-gate": [
        { convergeBlocked: true, convergeBlockReason: "1 unacknowledged suppressed advisory", convergeAckOnly: true },
        { convergeBlocked: false, convergeBlockReason: "", convergeAckOnly: false },
      ],
    },
  });
  assertThatInstance(engine, byProcessId("convergence-loop")).hasCompleted().hasNoIncident();
  // The instance finalized without parking a human escalation.
  assert(!(await openWaitAnswer(engine)), "no wait-answer user task must be opened on the auto-ack path");
  // The review-round agent ran twice: the initial round + the one bounded auto-ack re-dispatch.
  assert(completions(engine, "review-round") === 2, `review-round should run twice; ran ${completions(engine, "review-round")}`);
  // (A COMPLETED instance's variables are folded away — assert the retry via the element run count
  // above and the terminal converged element below, not a post-completion ackRetryRound read.)
  assert(completedElementIds(engine).has("persist-converged"), "the PR must finalize as converged");
});

// ── Acceptance: a NON-ack-only block (unresolved thread) still escalates ──────

test("a block with an unresolved inline thread is NOT ack-only and escalates to a human as before", async () => {
  const engine = await boot({
    responses: {
      "pr.converge-gate": { convergeBlocked: true, convergeBlockReason: "1 unresolved review thread", convergeAckOnly: false },
    },
  });
  assertThatInstance(engine, byProcessId("convergence-loop")).isActive().hasNoIncident();
  assert(await openWaitAnswer(engine), "a non-ack-only block must park the human wait-answer");
  // It never re-dispatched the agent for an auto-ack — the review-round ran only its initial round.
  assert(completions(engine, "review-round") === 1, "a non-ack-only block must not auto-ack-retry");
  assert(instanceVars(engine).ackRetryRound === 0, "a non-ack-only block must not consume the ack-retry budget");
});

// ── Acceptance: the auto-ack pass is BOUNDED — exhausting the budget escalates ─

test("an ack-only block with a zero budget escalates to a human on the first block (bounded)", async () => {
  const engine = await boot({
    vars: { ackRetryMax: 0 },
    responses: {
      "pr.converge-gate": { convergeBlocked: true, convergeBlockReason: "1 unacknowledged suppressed advisory", convergeAckOnly: true },
    },
  });
  assertThatInstance(engine, byProcessId("convergence-loop")).isActive().hasNoIncident();
  assert(await openWaitAnswer(engine), "an exhausted ack-retry budget must escalate to the human");
  assert(completedElementIds(engine).has("persist-escalation-blockedcomments"), "escalation must be the blocked-comments arm");
});

// ── Acceptance: a POSITIVE budget is exhausted — max-1 re-dispatches once, then escalates ─

test("an ack-only block with a max-1 budget re-dispatches EXACTLY once, then escalates on the second block", async () => {
  // Two CONSECUTIVE ack-only blocks with a budget of 1. This is the positive-budget exhaustion the
  // max-2 (converges after one block) and max-0 (escalates on the first block) cases never exercise:
  // it proves the `ackRetryRound <= ackRetryMax` gate performs exactly ONE re-dispatch and then, on
  // the SECOND ack-only block, routes to the human — catching an off-by-one in the `<=` / counter.
  const engine = await boot({
    vars: { ackRetryMax: 1 },
    responses: {
      "pr.converge-gate": [
        { convergeBlocked: true, convergeBlockReason: "1 unacknowledged suppressed advisory", convergeAckOnly: true },
        { convergeBlocked: true, convergeBlockReason: "1 unacknowledged suppressed advisory", convergeAckOnly: true },
      ],
    },
  });
  assertThatInstance(engine, byProcessId("convergence-loop")).isActive().hasNoIncident();
  assert(await openWaitAnswer(engine), "a max-1 budget must escalate on the SECOND ack-only block");
  assert(
    completedElementIds(engine).has("persist-escalation-blockedcomments"),
    "escalation must be the blocked-comments arm",
  );
  // Exactly one re-dispatch: the initial round + one auto-ack retry = two review-round runs (not three).
  assert(
    completions(engine, "review-round") === 2,
    `review-round should run exactly twice; ran ${completions(engine, "review-round")}`,
  );
  // The budget counter advanced once per ack-only block (0→1→2), landing PAST the max (1) — the exact
  // condition that flipped `ackRetryRound <= ackRetryMax` false on the second block. The instance is
  // still ACTIVE (parked on the human), so its variables are readable (a COMPLETED instance folds them).
  assert(
    instanceVars(engine).ackRetryRound === 2,
    `ackRetryRound should be 2 at the escalation; was ${instanceVars(engine).ackRetryRound}`,
  );
});

// ── Acceptance: a re-dispatched agent that needs input surfaces to a human ────
//
// This is the ONLY path a genuinely-contested advisory reaches a human (#796 reconciled with #787):
// the "contested → human" trigger is the agent returning `needs_input` (it cannot decide), NOT the
// agent posting a reasoned `Declined, false positive. nano-ack: …`. A resolved decline is an agent
// adjudication that converges by design (#787) — a stateless converge-gate cannot re-block a decline
// without re-introducing the #787 per-round-escalation livelock. Decline = adjudicated → converge;
// needs_input = deferred → human.

test("a contested advisory — the re-dispatched agent returns needs_input — surfaces to a human", async () => {
  const engine = await boot({
    responses: {
      "senior:pr-review": [
        { status: "converged", summary: "round 1" },
        { status: "needs_input", summary: "contested", question: "Is this advisory a real defect?" },
      ],
      "pr.converge-gate": { convergeBlocked: true, convergeBlockReason: "1 unacknowledged suppressed advisory", convergeAckOnly: true },
    },
  });
  assertThatInstance(engine, byProcessId("convergence-loop")).isActive().hasNoIncident();
  assert(await openWaitAnswer(engine), "a re-dispatched agent that needs input must reach the human wait-answer");
  // It DID try the bounded auto-ack once (the second review-round run), then the agent's needs_input
  // verdict routed it to the human via the normal status escalation arm.
  assert(completions(engine, "review-round") === 2, `review-round should run twice; ran ${completions(engine, "review-round")}`);
});
