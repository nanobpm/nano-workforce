// Red/green for issue #879: the agent-task SLA escalation must distinguish a NEVER-ACTIVATED
// (queue-starved) agent job from an ACTIVATED-but-hung one, name the job type, and say how long it
// waited — never the old blanket "it is hung or looping" for a job no worker ever picked up.
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "#test-assert";
import { recordAgentJobObservation } from "./agentActivationLedger.ts";
import {
  agentSlaEscalationQuestion,
  buildAgentSlaEscalationReason,
  humanizeIsoDuration,
  humanizeMs,
} from "./agentSlaEscalation.ts";
import { memDataFor } from "../test/worldDb.ts";

const RECOVERY = "Answer to resume, or abandon it.";

test("humanizeMs renders a compact span and floors sub-minute to seconds", () => {
  assertEquals(humanizeMs(2 * 3600_000 + 5 * 60_000), "2h 5m");
  assertEquals(humanizeMs(45 * 60_000), "45m");
  assertEquals(humanizeMs(30_000), "30s");
  assertEquals(humanizeMs(0), "less than a minute");
  assertEquals(humanizeMs(-5), "less than a minute");
  assertEquals(humanizeMs(Number.NaN), "less than a minute");
});

test("humanizeIsoDuration humanizes the SLA budget", () => {
  assertEquals(humanizeIsoDuration("PT2H"), "2h");
  assertEquals(humanizeIsoDuration("PT15M"), "15m");
});

test("never-observed-activated: queue starvation is reported hedged, NOT as hung or looping", () => {
  const reason = buildAgentSlaEscalationReason({
    jobType: "senior:feature",
    sla: "PT2H",
    // Observed queued, never leased (activated_at null) → the defect scenario.
    activation: { firstSeenAt: "2024-01-01T00:00:00Z", activatedAt: null, worker: null },
    now: "2024-01-01T02:00:00Z",
    recovery: RECOVERY,
  });
  assertStringIncludes(reason, "senior:feature");
  // Observational, hedged wording — never the over-confident "the agent never started".
  assertStringIncludes(reason, "No worker was ever observed to pick up");
  assertStringIncludes(reason, "queue starvation");
  // Names how long it waited and the SLA budget.
  assertStringIncludes(reason, "2h");
  // Acknowledges the poll-window race rather than claiming certainty (issue #881 review).
  assertStringIncludes(reason, "that would not have been recorded");
  // Must NOT misdiagnose it as hung/looping.
  assertEquals(reason.includes("may be hung or looping"), false);
  assertEquals(reason.includes("agent never started"), false);
  assertStringIncludes(reason, RECOVERY);
});

test("started-but-exceeded: a leased job may be hung or looping", () => {
  const reason = buildAgentSlaEscalationReason({
    jobType: "senior:trial-merge",
    sla: "PT2H",
    activation: {
      firstSeenAt: "2024-01-01T00:00:00Z",
      activatedAt: "2024-01-01T00:10:00Z",
      worker: "agent-7",
    },
    now: "2024-01-01T02:10:00Z",
    recovery: RECOVERY,
  });
  assertStringIncludes(reason, "senior:trial-merge");
  assertStringIncludes(reason, "started");
  assertStringIncludes(reason, "hung or looping");
  // Reports both the queue wait and the run time, plus the worker.
  assertStringIncludes(reason, "10m");
  assertStringIncludes(reason, "agent-7");
  assertEquals(reason.includes("never started"), false);
});

test("activation unknown: the poller never observed the job → honest ambiguity", () => {
  const reason = buildAgentSlaEscalationReason({
    jobType: "senior:retro",
    sla: "PT2H",
    activation: null,
    now: "2024-01-01T02:00:00Z",
    recovery: RECOVERY,
  });
  assertStringIncludes(reason, "senior:retro");
  assertStringIncludes(reason, "no worker-activation was ever recorded");
  assertEquals(reason.includes("hung or looping"), false);
});

test("agentSlaEscalationQuestion reads the ledger and distinguishes never-started", async () => {
  const { data } = memDataFor(["119_agent_job_activations.sql"]);
  // A queued-but-never-activated observation (worker null).
  await recordAgentJobObservation(data, {
    processInstanceKey: "PI-1",
    jobType: "senior:feature",
    worker: null,
    now: "2024-01-01T00:00:00Z",
  });
  const q = await agentSlaEscalationQuestion(data, {
    processInstanceKey: "PI-1",
    jobType: "senior:feature",
    sla: "PT2H",
    recovery: RECOVERY,
    now: "2024-01-01T02:00:00Z",
  });
  assertStringIncludes(q, "No worker was ever observed to pick up");
  assertEquals(q.includes("may be hung or looping"), false);
});

test("agentSlaEscalationQuestion reads an activated observation as started-but-hung", async () => {
  const { data } = memDataFor(["119_agent_job_activations.sql"]);
  await recordAgentJobObservation(data, {
    processInstanceKey: "PI-2",
    jobType: "senior:feature",
    worker: "agent-x",
    now: "2024-01-01T00:05:00Z",
  });
  const q = await agentSlaEscalationQuestion(data, {
    processInstanceKey: "PI-2",
    jobType: "senior:feature",
    sla: "PT2H",
    recovery: RECOVERY,
    now: "2024-01-01T02:05:00Z",
  });
  assertStringIncludes(q, "hung or looping");
  assertStringIncludes(q, "agent-x");
});

test("agentSlaEscalationQuestion with no ledger row reports activation unknown", async () => {
  const { data } = memDataFor(["119_agent_job_activations.sql"]);
  const q = await agentSlaEscalationQuestion(data, {
    processInstanceKey: "PI-404",
    jobType: "senior:feature",
    sla: "PT2H",
    recovery: RECOVERY,
    now: "2024-01-01T02:00:00Z",
  });
  assertStringIncludes(q, "no worker-activation was ever recorded");
});
