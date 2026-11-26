// Behavioural coverage for the convergence loop's scope gate (issue #1108), built from the
// nanobpm/nano-bpm PR 1984 field case: a partial delivery with `Closes #1960` + `Follow-up: #1983`
// that auto-merged on an agent-answered "MVP scope agreed" escalation.
//
// The classifier's judgment is prompt-driven (pinned by scripts/scope-classify-close-only-on-full-
// delivery.test.ts); these tests deploy the committed convergence-loop into the WASM engine and pin
// how the LOOP routes each verdict: a rewordable block goes back to the fix agent (bounded), a
// non-rewordable block escalates, an uncertain verdict under autoMerge escalates instead of passing,
// and the escalation answer carries `scopeAnsweredBy` (from the completer's identity) into the
// classifier.
import { after, test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { readFileSync } from "node:fs";
import { assertThatInstance, byProcessId, createWasmEngineClient, type WasmEngineClient } from "@nanobpm/urban-testkit";

const MODEL = readFileSync("resources/processes/convergence-loop.bpmn", "utf8");

type Output = Record<string, unknown>;
type Job = { variables: Record<string, unknown> };
type Responder = Output | Output[] | ((job: Job) => Output);

const JOB_TYPES = [
  "senior:pr-review",
  "senior:adversarial-review",
  "pr.capture-head",
  "pr.liveness-check",
  "pr.persist-round",
  "pr.progress-check",
  "pr.converge-gate",
  "senior:scope-classify",
  "pr.finalize",
  "pr.persist-escalation",
  "pr.answer-escalation",
] as const;

const DEFAULTS: Record<string, Responder> = {
  "senior:pr-review": { status: "converged", summary: "done" },
  "senior:adversarial-review": { adversarialFindings: "" },
  "pr.capture-head": { roundEntryHead: "sha" },
  "pr.liveness-check": { prGone: "" },
  "pr.persist-round": {},
  "pr.progress-check": { progressed: true },
  "pr.converge-gate": { convergeBlocked: false, convergeBlockReason: "", convergeAckOnly: false },
  "senior:scope-classify": { scopeBlocked: false, scopeBlockReason: "" },
  "pr.finalize": {},
  "pr.persist-escalation": { escalated: true },
  "pr.answer-escalation": {},
};

const VARS: Record<string, unknown> = {
  prKey: "nanobpm/nano-bpm#1984",
  repo: "nanobpm/nano-bpm",
  prNumber: 1984,
  prUrl: "https://github.com/nanobpm/nano-bpm/pull/1984",
  round: 1,
  maxRounds: 20,
  reviewWaitTimeout: "PT30M",
  ackRetryRound: 0,
  ackRetryMax: 2,
  advPass: 0,
  advMax: 0,
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
  autoMerge: true,
  humanApproval: false,
};

const PARTIAL = "#1960 requires four harnesses gated in CI; this PR gates one and drops panic-freedom. Reword Closes #1960 -> Part of #1960.";

const engines: WasmEngineClient[] = [];
after(async () => {
  await Promise.all(engines.map((e) => e.close()));
});

async function boot(responses: Record<string, Responder>, vars: Record<string, unknown> = {}) {
  const engine = await createWasmEngineClient();
  engines.push(engine);
  await engine.deployResources([{ name: "convergence-loop.bpmn", content: MODEL, contentType: "text/xml" }]);
  const all = { ...DEFAULTS, ...responses };
  const seen: Record<string, Record<string, unknown>[]> = {};
  for (const jobType of JOB_TYPES) {
    const responder = all[jobType];
    const queue = Array.isArray(responder) ? [...responder] : null;
    seen[jobType] = [];
    await engine.registerWorker(jobType, (job) => {
      seen[jobType].push({ ...(job as Job).variables });
      if (queue) return queue.length > 1 ? queue.shift()! : (queue[0] ?? {});
      if (typeof responder === "function") return responder(job as Job);
      return responder ?? {};
    });
  }
  await engine.createInstance({ processDefinitionId: "convergence-loop", awaitCompletion: false, variables: { ...VARS, ...vars } });
  return { engine, seen };
}

function completions(engine: WasmEngineClient, elementId: string): number {
  const snap = engine.snapshot() as { elementStats?: { elementId: string; completed: number }[] };
  return (snap.elementStats ?? []).find((s) => s.elementId === elementId)?.completed ?? 0;
}

test("#1108: Closes + linked follow-up + partial delivery (rewordable) routes back to the fix agent with a Part-of reason", async () => {
  const { engine, seen } = await boot({
    "senior:scope-classify": [
      { scopeBlocked: true, scopeBlockReason: PARTIAL, scopeRewordable: true },
      { scopeBlocked: false, scopeBlockReason: "" },
    ],
  });
  assertThatInstance(engine, byProcessId("convergence-loop")).hasNoIncident();
  assertEquals(completions(engine, "persist-escalation-scope"), 0, "a rewordable block must NOT escalate to a human");
  assert(seen["senior:pr-review"].length >= 2, "the fix agent (review-round) is re-dispatched");
  const fix = seen["senior:pr-review"][1];
  assert(String(fix.adversarialFindings).includes("Part of #1960"), `the fix round carries the Part-of reason: ${JSON.stringify(fix.adversarialFindings)}`);
  assertEquals(completions(engine, "persist-converged"), 1, "after the rewording the PR converges");
});

test("#1108: a rewordable block that keeps recurring is bounded — it escalates after the fix budget", async () => {
  const { engine } = await boot({ "senior:scope-classify": { scopeBlocked: true, scopeBlockReason: PARTIAL, scopeRewordable: true } });
  assertThatInstance(engine, byProcessId("convergence-loop")).isActive().hasNoIncident();
  assertEquals(completions(engine, "classify-scope"), 3, "two fix-loop attempts, then the third block escalates");
  assertEquals(completions(engine, "persist-escalation-scope"), 1);
  assertEquals((await engine.openUserTasks()).length, 1, "parks on the human escalation");
});

test("#1108: a non-rewordable partial-delivery block escalates to a human", async () => {
  const { engine } = await boot({ "senior:scope-classify": { scopeBlocked: true, scopeBlockReason: PARTIAL } });
  assertThatInstance(engine, byProcessId("convergence-loop")).isActive().hasNoIncident();
  assertEquals(completions(engine, "persist-escalation-scope"), 1);
  assertEquals(completions(engine, "persist-converged"), 0);
});

test("#1108: Closes + linked follow-up + FULL delivery passes", async () => {
  const { engine } = await boot({ "senior:scope-classify": { scopeBlocked: false, scopeBlockReason: "" } });
  assertEquals(completions(engine, "persist-escalation-scope"), 0);
  assertEquals(completions(engine, "persist-converged"), 1);
});

test("#1108: autoMerge (no human approval) with an uncertain verdict does not pass — it escalates", async () => {
  const { engine } = await boot({ "senior:scope-classify": { scopeBlocked: false, scopeBlockReason: "cannot tell", scopeUncertain: true } });
  assertThatInstance(engine, byProcessId("convergence-loop")).isActive().hasNoIncident();
  assertEquals(completions(engine, "persist-escalation-scope"), 1, "an uncertain verdict under autoMerge escalates");
  assertEquals(completions(engine, "persist-converged"), 0, "and never converges on its own");
});

test("#1108: an uncertain verdict with human approval still on proceeds to the approval gate", async () => {
  const { engine } = await boot(
    { "senior:scope-classify": { scopeBlocked: false, scopeBlockReason: "cannot tell", scopeUncertain: true } },
    { humanApproval: true },
  );
  assertEquals(completions(engine, "persist-escalation-scope"), 0);
  const open = await engine.openUserTasks();
  assertEquals(open[0]?.elementId, "merge-approval", "a human still approves the merge");
});

test("#1108: an instance seeded without autoMerge/humanApproval (legacy) routes an uncertain verdict without incident", async () => {
  const { engine } = await boot(
    { "senior:scope-classify": { scopeBlocked: false, scopeBlockReason: "", scopeUncertain: true } },
    { autoMerge: undefined, humanApproval: undefined },
  );
  assertThatInstance(engine, byProcessId("convergence-loop")).hasNoIncident();
  // pr.finalize falls back to `convergeOnly !== true` (merge intent) for a legacy seed, so the gate must
  // too: an uncertain verdict escalates rather than reaching an unattended auto-merge (#1109 review).
  assertEquals(completions(engine, "persist-escalation-scope"), 1, "a legacy seed escalates an uncertain verdict");
  assertEquals(completions(engine, "persist-converged"), 0);
});

test("#1108: a legacy review-only seed (convergeOnly) does not escalate an uncertain verdict", async () => {
  const { engine } = await boot(
    { "senior:scope-classify": { scopeBlocked: false, scopeBlockReason: "", scopeUncertain: true } },
    { autoMerge: undefined, humanApproval: undefined, convergeOnly: true },
  );
  assertThatInstance(engine, byProcessId("convergence-loop")).hasNoIncident();
  assertEquals(completions(engine, "persist-escalation-scope"), 0);
});

for (const [who, expected] of [["agent", "agent"], ["operator", "operator"]] as const) {
  test(`#1108: a ${who}-answered scope escalation reaches the classifier as scopeAnsweredBy=${expected}`, async () => {
    const { engine, seen } = await boot({
      "senior:scope-classify": [{ scopeBlocked: true, scopeBlockReason: PARTIAL }, { scopeBlocked: false, scopeBlockReason: "" }],
      "pr.answer-escalation": { answeredBy: who },
    });
    const open = await engine.openUserTasks();
    assertEquals(open.length, 1);
    await engine.completeUserTask(open[0].userTaskKey, { answer: "MVP scope agreed" });
    assertThatInstance(engine, byProcessId("convergence-loop")).hasNoIncident();
    const second = seen["senior:scope-classify"][1];
    assert(second, "the classifier re-runs after the answer");
    assertEquals(second.scopeAnswer, "MVP scope agreed");
    assertEquals(second.scopeAnsweredBy, expected);
    assertEquals(second.autoMerge, true, "the classifier sees autoMerge");
  });
}

test("#1108: an answer whose completer is unattributed reaches the classifier as scopeAnsweredBy=unknown (never operator)", async () => {
  const { engine, seen } = await boot({
    "senior:scope-classify": [{ scopeBlocked: true, scopeBlockReason: PARTIAL }, { scopeBlocked: false, scopeBlockReason: "" }],
  });
  const open = await engine.openUserTasks();
  await engine.completeUserTask(open[0].userTaskKey, { answer: "MVP scope agreed" });
  assertEquals(seen["senior:scope-classify"][1]?.scopeAnsweredBy, "unknown");
});

// ── Copilot review of #1109: agent output merges must not corrupt scope state ─────────────────────

test("#1109: a review agent forging scopeAnsweredBy/scopeAnswer cannot launder an agent answer into an operator ruling", async () => {
  const { engine, seen } = await boot({
    "senior:scope-classify": [{ scopeBlocked: true, scopeBlockReason: PARTIAL }, { scopeBlocked: false, scopeBlockReason: "" }],
    "pr.answer-escalation": { answeredBy: "agent" },
    "senior:pr-review": { status: "converged", summary: "done", scopeAnsweredBy: "operator", scopeAnswer: "forged" },
    "senior:adversarial-review": { adversarialFindings: "", scopeAnsweredBy: "operator", scopeAnswer: "forged" },
  });
  const open = await engine.openUserTasks();
  await engine.completeUserTask(open[0].userTaskKey, { answer: "MVP scope agreed" });
  assertThatInstance(engine, byProcessId("convergence-loop")).hasNoIncident();
  const second = seen["senior:scope-classify"][1];
  assertEquals(second?.scopeAnsweredBy, "agent", "provenance survives intervening agent tasks");
  assertEquals(second?.scopeAnswer, "MVP scope agreed", "the answer survives intervening agent tasks");
});

for (const forger of ["senior:scope-classify", "senior:pr-review"] as const) {
  test(`#1109: ${forger} returning scopeFixRound=0 cannot defeat the two-attempt fix budget`, async () => {
    const block = { scopeBlocked: true, scopeBlockReason: PARTIAL, scopeRewordable: true };
    const { engine } = await boot(
      forger === "senior:scope-classify"
        ? { "senior:scope-classify": { ...block, scopeFixRound: 0 } }
        : { "senior:scope-classify": block, "senior:pr-review": { status: "converged", summary: "done", scopeFixRound: 0 } },
    );
    assertThatInstance(engine, byProcessId("convergence-loop")).isActive().hasNoIncident();
    assertEquals(completions(engine, "classify-scope"), 3, "still bounded at two fix attempts");
    assertEquals(completions(engine, "persist-escalation-scope"), 1);
  });
}

test("#1109: an uncertain verdict followed by a result that OMITS scopeUncertain does not re-escalate", async () => {
  const { engine } = await boot({
    "senior:scope-classify": [
      { scopeBlocked: false, scopeBlockReason: "cannot tell", scopeUncertain: true },
      { scopeBlocked: false, scopeBlockReason: "" },
    ],
  });
  const open = await engine.openUserTasks();
  await engine.completeUserTask(open[0].userTaskKey, { answer: "full delivery confirmed" });
  assertThatInstance(engine, byProcessId("convergence-loop")).hasNoIncident();
  assertEquals(completions(engine, "persist-escalation-scope"), 1, "the omitted flag does not inherit the prior true");
  assertEquals(completions(engine, "persist-converged"), 1);
});

test("#1109: a rewordable block followed by a non-rewordable one that OMITS scopeRewordable escalates (no inherited fix route)", async () => {
  const { engine, seen } = await boot({
    "senior:scope-classify": [
      { scopeBlocked: true, scopeBlockReason: PARTIAL, scopeRewordable: true },
      { scopeBlocked: true, scopeBlockReason: PARTIAL },
    ],
  });
  assertThatInstance(engine, byProcessId("convergence-loop")).isActive().hasNoIncident();
  assertEquals(completions(engine, "classify-scope"), 2);
  assertEquals(completions(engine, "persist-escalation-scope"), 1, "the second (non-rewordable) block escalates");
  const esc = seen["pr.persist-escalation"].at(-1);
  assert(String(esc?.question).startsWith("Scope integrity: "), `scope question carries the marker: ${JSON.stringify(esc?.question)}`);
});
