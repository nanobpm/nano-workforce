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
  humanApproval: false,
  convergeOnly: false,
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
  const created = await engine.createInstance({
    processDefinitionId: "convergence-loop",
    awaitCompletion: false,
    variables: { ...DEFAULT_VARS, ...(opts.vars ?? {}) },
  });
  return { engine, processInstanceKey: created.processInstanceKey };
}

function instanceVars(engine: WasmEngineClient): Record<string, unknown> {
  const snap = engine.snapshot() as { instances?: { variables?: Record<string, unknown> }[] };
  return snap.instances?.[0]?.variables ?? {};
}

/** Read one variable's deserialized value via the engine read channel — works on a COMPLETED instance. */
async function variableValue(engine: WasmEngineClient, processInstanceKey: string, name: string): Promise<unknown> {
  const rows = await engine.searchVariables({ processInstanceKey, name });
  const row = rows.find((v) => v.name === name);
  assert(row, `expected variable ${name} to be present`);
  return JSON.parse(row.value);
}

test("a review-round agent echoing round:\"4\" does not clobber the engine-owned counter or wedge gw-guard", async () => {
  const { engine } = await boot({
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
  const { engine } = await boot({
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

test("a review-round agent echoing PR identity inputs cannot alter them", async () => {
  // `repo`/`prNumber`/`prUrl` are the agent's declared *inputs* (PrReviewRoundIn), not its outputs —
  // but the engine merges a completion UNFILTERED, so an input-echo would replace the valid process
  // identity that `progress-check`, `converge-gate`, and `finalize` go on to read. The snapshot/restore
  // guard must pin them.
  const { engine } = await boot({
    responses: {
      "senior:pr-review": {
        status: "addressed",
        summary: "fixed",
        repo: "evil/repo",
        prNumber: 999,
        prUrl: "https://evil.test/pr/999",
      },
    },
  });
  const incidents = await engine.searchIncidents();
  assertEquals(incidents.length, 0, `no incident; got: ${JSON.stringify(incidents)}`);
  const vars = instanceVars(engine);
  assertEquals(vars.repo, "o/r", "repo must be unchanged");
  assertEquals(vars.prNumber, 1, "prNumber must be unchanged");
  assertEquals(vars.prUrl, "https://example.test/pr/1", "prUrl must be unchanged");
});

// The adversarial reviewer (`senior:adversarial-review`) and scope classifier
// (`senior:scope-classify`) are hardened by the SAME snapshot/restore mappings as `review-round`;
// these drive each of those tasks with an engine-owned-field echo so removing either task's guard
// turns this suite red (the `review-round` regressions above would stay green).

test("an adversarial-review agent echoing engine counters cannot alter them", async () => {
  // advMax: 1 makes the adversarial pass due on round 1. The agent echoes `advPass`/`advMax` (and a
  // counter) as the WRONG type; the guard must keep the engine's own increment (0 → 1) and budget.
  const { engine } = await boot({
    vars: { advMax: 1 },
    responses: {
      "senior:adversarial-review": { adversarialFindings: "", adversarialSummary: "clean", advPass: "7", advMax: "0", round: "9" },
    },
  });
  const incidents = await engine.searchIncidents();
  assertEquals(incidents.length, 0, `no incident; got: ${JSON.stringify(incidents)}`);
  const vars = instanceVars(engine);
  assertEquals(vars.advPass, 1, "advPass must be the engine increment (0 → 1), not the agent's \"7\"");
  assertEquals(vars.advMax, 1, "advMax budget ceiling must be unchanged");
  assertEquals(vars.round, 1, "round must be unchanged");
});

test("an adversarial-review agent echoing PR identity inputs cannot alter them", async () => {
  const { engine } = await boot({
    vars: { advMax: 1 },
    responses: {
      "senior:adversarial-review": {
        adversarialFindings: "",
        adversarialSummary: "clean",
        repo: "evil/repo",
        prNumber: 999,
        prUrl: "https://evil.test/pr/999",
      },
    },
  });
  const incidents = await engine.searchIncidents();
  assertEquals(incidents.length, 0, `no incident; got: ${JSON.stringify(incidents)}`);
  const vars = instanceVars(engine);
  assertEquals(vars.repo, "o/r", "repo must be unchanged");
  assertEquals(vars.prNumber, 1, "prNumber must be unchanged");
  assertEquals(vars.prUrl, "https://example.test/pr/1", "prUrl must be unchanged");
});

test("a scope-classify agent echoing engine-owned fields cannot alter them", async () => {
  // Drive to the scope classifier via a `converged` review. The classifier echoes prKey + the PR
  // identity inputs; the guard must keep them. The instance runs to completion, so read the
  // variables back through the read channel (a completed instance's `snapshot().variables` is folded).
  const { engine, processInstanceKey } = await boot({
    responses: {
      "senior:pr-review": { status: "converged", summary: "done" },
      "senior:scope-classify": {
        scopeBlocked: false,
        scopeBlockReason: "",
        prKey: "evil/repo#999",
        repo: "evil/repo",
        prNumber: 999,
        prUrl: "https://evil.test/pr/999",
      },
    },
  });
  const incidents = await engine.searchIncidents();
  assertEquals(incidents.length, 0, `no incident; got: ${JSON.stringify(incidents)}`);
  assertEquals(await variableValue(engine, processInstanceKey, "prKey"), "o/r#1", "prKey correlation key must be unchanged");
  assertEquals(await variableValue(engine, processInstanceKey, "repo"), "o/r", "repo must be unchanged");
  assertEquals(await variableValue(engine, processInstanceKey, "prNumber"), 1, "prNumber must be unchanged");
  assertEquals(await variableValue(engine, processInstanceKey, "prUrl"), "https://example.test/pr/1", "prUrl must be unchanged");
});

// ---------------------------------------------------------------------------
// Issue #887 (round 3): the seeded merge-control gates `humanApproval` and
// `convergeOnly` are ALSO engine-owned and must survive an agent completion.
// A converged review that echoes `humanApproval:false` would bypass `gw-approval`
// (skip the required human merge approval), and `convergeOnly:false` would hand a
// review-only PR to the merge loop. The snapshot/restore guard pins both.
//
// `humanApproval` is MONOTONIC (false→true only — the host flips it true via
// `engine.setVariables` when a gated caller adopts a live loop, app/service.ts).
// So its restore is `(guardHumanApproval = true) or (humanApproval = true)`: it
// recovers a snapshot-true against an agent's false AND preserves a concurrent
// host-set true, but never lets an agent force it back to false.
// ---------------------------------------------------------------------------

test("a review-round agent echoing humanApproval:false cannot bypass the approval gate", async () => {
  // Seeded gated (humanApproval:true). The agent echoes false; the monotonic restore must keep it true.
  const { engine } = await boot({
    vars: { humanApproval: true },
    responses: { "senior:pr-review": { status: "addressed", summary: "fixed", humanApproval: false } },
  });
  const incidents = await engine.searchIncidents();
  assertEquals(incidents.length, 0, `no incident; got: ${JSON.stringify(incidents)}`);
  assertEquals(instanceVars(engine).humanApproval, true, "seeded humanApproval:true must survive the agent's false echo");
});

test("a review-round agent echoing convergeOnly:false cannot re-target a review-only run at the merge loop", async () => {
  // Seeded review-only (convergeOnly:true). The agent echoes false; the restore must keep it true.
  const { engine } = await boot({
    vars: { convergeOnly: true },
    responses: { "senior:pr-review": { status: "addressed", summary: "fixed", convergeOnly: false } },
  });
  const incidents = await engine.searchIncidents();
  assertEquals(incidents.length, 0, `no incident; got: ${JSON.stringify(incidents)}`);
  assertEquals(instanceVars(engine).convergeOnly, true, "seeded convergeOnly:true must survive the agent's false echo");
});

test("an adversarial-review agent echoing humanApproval/convergeOnly cannot alter the seeded gates", async () => {
  const { engine } = await boot({
    vars: { advMax: 1, humanApproval: true, convergeOnly: true },
    responses: {
      "senior:adversarial-review": {
        adversarialFindings: "",
        adversarialSummary: "clean",
        humanApproval: false,
        convergeOnly: false,
      },
    },
  });
  const incidents = await engine.searchIncidents();
  assertEquals(incidents.length, 0, `no incident; got: ${JSON.stringify(incidents)}`);
  const vars = instanceVars(engine);
  assertEquals(vars.humanApproval, true, "humanApproval gate must be unchanged");
  assertEquals(vars.convergeOnly, true, "convergeOnly flag must be unchanged");
});

test("a scope-classify agent echoing humanApproval/convergeOnly cannot alter the seeded gates", async () => {
  // Drive to the scope classifier via a `converged` review with the gates seeded true; the classifier
  // echoes them false. With humanApproval:true the instance then parks at the merge-approval user task
  // (still ACTIVE), so read the gates back through the variables channel after classify-scope ran.
  const { engine, processInstanceKey } = await boot({
    vars: { humanApproval: true, convergeOnly: true },
    responses: {
      "senior:pr-review": { status: "converged", summary: "done" },
      "senior:scope-classify": {
        scopeBlocked: false,
        scopeBlockReason: "",
        humanApproval: false,
        convergeOnly: false,
      },
    },
  });
  const incidents = await engine.searchIncidents();
  assertEquals(incidents.length, 0, `no incident; got: ${JSON.stringify(incidents)}`);
  assertEquals(await variableValue(engine, processInstanceKey, "humanApproval"), true, "humanApproval gate must be unchanged");
  assertEquals(await variableValue(engine, processInstanceKey, "convergeOnly"), true, "convergeOnly flag must be unchanged");
});
