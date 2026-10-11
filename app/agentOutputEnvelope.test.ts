// Regression guard for issue #887 — an external-agent job's completion variables must not clobber
// engine-owned process state.
//
// The defect (merlin PI 351101, incident 363350 at `gw-guard`): a `senior:pr-review` job returned
// `round: "4"` (a STRING) alongside its result. The engine merges EVERY variable an external agent
// returns into process scope UNFILTERED (the `io.nanobpm.dataEnvelope.out` shape is typing-only — no
// runtime filtering/coercion), so the agent's string overwrote the engine-owned integer counter
// `round`. The next `gw-guard` evaluation (`round >= maxRounds`) then raised
//   "comparison not defined for string and number"
// and wedged the loop on an unrecoverable incident.
//
// Failure CLASS: any external-agent task can corrupt engine-owned state (round, maxRounds, the
// adversarial/ack/husk counters, prKey…) by name collision or type drift. The categorical fix snapshots
// each engine-owned control variable into a task-LOCAL input before the agent runs and RESTORES it from
// that snapshot on the task's output mapping, so an agent completion can never alter it (the snapshot is
// the pre-merge value; an output `source="=round"` would read the already-clobbered merge — proven by the
// `app/agentCompletion*`/testkit notes). The agent's real outputs (status/summary/question for a review
// round, findings for the adversarial pass, the scope verdict) still flow through untouched.
//
// These deploy the committed convergence-loop into the real WASM engine and drive a token to `gw-guard`
// with an agent that echoes `round: "4"`; the fix means NO incident is raised and `round` stays the
// engine-managed integer.
import { after, test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { readFileSync } from "node:fs";
import { createWasmEngineClient, type WasmEngineClient } from "@nanobpm/urban-testkit";

const MODEL = readFileSync("resources/processes/convergence-loop.bpmn", "utf8");

type Output = Record<string, unknown>;
type Responder = Output | ((job: { variables: Record<string, unknown> }) => Output);

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
  "senior:adversarial-review": { adversarialFindings: "", adversarialSummary: "clean" },
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

async function boot(opts: { responses?: Record<string, Responder>; vars?: Record<string, unknown> } = {}) {
  const engine = await createWasmEngineClient();
  engines.push(engine);
  await engine.deployResources([{ name: "convergence-loop.bpmn", content: MODEL, contentType: "text/xml" }]);
  const responses = { ...DEFAULT_RESPONSES, ...(opts.responses ?? {}) };
  for (const jobType of ALL_JOB_TYPES) {
    const responder = responses[jobType];
    await engine.registerWorker(jobType, (job) =>
      typeof responder === "function" ? responder(job as { variables: Record<string, unknown> }) : (responder ?? {}),
    );
  }
  await engine.createInstance({
    processDefinitionId: "convergence-loop",
    awaitCompletion: false,
    variables: { ...DEFAULT_VARS, ...(opts.vars ?? {}) },
  });
  return engine;
}

function instanceVars(engine: WasmEngineClient): Record<string, unknown> {
  const snap = engine.snapshot() as { instances?: { variables?: Record<string, unknown> }[] };
  return snap.instances?.[0]?.variables ?? {};
}

test("a review-round agent echoing round:\"4\" does not clobber the engine-owned counter or wedge gw-guard", async () => {
  const engine = await boot({
    responses: { "senior:pr-review": { status: "addressed", summary: "fixed", round: "4" } },
  });
  // gw-guard evaluates `round >= maxRounds`. If the agent's string "4" clobbered `round`, the engine
  // raises "comparison not defined for string and number" and parks the token on an open incident.
  const incidents = await engine.searchIncidents();
  assertEquals(incidents.length, 0, `no incident must be raised; got: ${JSON.stringify(incidents)}`);
  // The engine-owned counter must remain the integer it was — untouched by the agent's echo.
  assertEquals(instanceVars(engine).round, 1, "engine-owned `round` must stay the integer 1, unclobbered");
});

test("a review-round agent echoing numeric engine counters cannot alter them", async () => {
  // A well-formed numeric echo must still be ignored — the agent owns NONE of these control variables.
  const engine = await boot({
    responses: {
      "senior:pr-review": { status: "addressed", summary: "fixed", round: 99, maxRounds: 1, prKey: "evil/repo#999" },
    },
  });
  const incidents = await engine.searchIncidents();
  assertEquals(incidents.length, 0, `no incident; got: ${JSON.stringify(incidents)}`);
  const vars = instanceVars(engine);
  assertEquals(vars.round, 1, "round must be unchanged");
  assertEquals(vars.maxRounds, 20, "maxRounds must be unchanged");
  assertEquals(vars.prKey, "o/r#1", "prKey correlation key must be unchanged");
});
