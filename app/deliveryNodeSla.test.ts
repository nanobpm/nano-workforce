// Issue #1016: a delivery-graph agent node's work SLA must not count queue time. The poller records each
// delivery node's job activation under a node-qualified ledger key, and `deliveryNodeSlaCheck` reports the
// work SLA expired ONLY once it has elapsed since activation, with a reason stating the facts.
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "#test-assert";
import { deliveryNodeActivationJobType, getAgentJobActivation, recordAgentJobObservation } from "./agentActivationLedger.ts";
import { deliveryNodeSlaCheck } from "./agentSlaEscalation.ts";
import { pollAgentActivationsImpl } from "./service.ts";
import { currentWatchedJobKey, watchedTaskElement } from "../workers/agent-sla-check/worker.ts";
import { AGENT_SLA_CHECK_MAX_INTERVAL } from "./deliveryGraphCompiler.ts";
import { agentSlaCheckEvery } from "./deliveryRunner.ts";
import { memDataFor } from "../test/worldDb.ts";

const MIG = ["119_agent_job_activations.sql"];
const key = deliveryNodeActivationJobType("senior:feature", "n0_task");

test("never-activated delivery node job → not expired (queue time never escalates)", async () => {
  const { data } = memDataFor(MIG);
  await recordAgentJobObservation(data, { processInstanceKey: "PI", jobType: key, worker: null, jobKey: "J1", now: "2026-11-22T00:00:00Z" });
  const r = await deliveryNodeSlaCheck(data, { processInstanceKey: "PI", activationJobType: key, jobType: "senior:feature", currentJobKey: "J1", sla: "PT1H", now: "2026-11-22T05:00:00Z" });
  assertEquals(r.expired, false);
});

test("unobserved delivery node job → not expired (activation not provable, nothing is cancelled)", async () => {
  const { data } = memDataFor(MIG);
  const r = await deliveryNodeSlaCheck(data, { processInstanceKey: "PI", activationJobType: key, jobType: "senior:feature", currentJobKey: "J1", sla: "PT1H" });
  assertEquals(r.expired, false);
});

test("activated shortly before the ENTRY deadline → full work budget from activation, then escalate with the facts", async () => {
  const { data } = memDataFor(MIG);
  await recordAgentJobObservation(data, { processInstanceKey: "PI", jobType: key, worker: null, jobKey: "J1", now: "2026-11-22T00:00:00Z" });
  await recordAgentJobObservation(data, { processInstanceKey: "PI", jobType: key, worker: "merlin-1", jobKey: "J1", now: "2026-11-22T00:59:00Z" });
  // The entry-anchored boundary fires at 01:00 — one minute into the work: must NOT expire.
  const early = await deliveryNodeSlaCheck(data, { processInstanceKey: "PI", activationJobType: key, jobType: "senior:feature", currentJobKey: "J1", sla: "PT1H", now: "2026-11-22T01:00:00Z" });
  assertEquals(early.expired, false);
  const late = await deliveryNodeSlaCheck(data, { processInstanceKey: "PI", activationJobType: key, jobType: "senior:feature", currentJobKey: "J1", sla: "PT1H", now: "2026-11-22T02:00:00Z" });
  assertEquals(late.expired, true);
  assertStringIncludes(late.reason, "merlin-1");
  assertStringIncludes(late.reason, "2026-11-22T00:59:00Z");
  assertEquals(late.reason.includes("may already exist"), false);
});

test("issue #1016 review: a Retry checked BEFORE the poller observes the new attempt never reads the previous attempt's activation", async () => {
  const { data } = memDataFor(MIG);
  // Attempt J1 activated long ago (its expiry escalated); the retried job J2 is live but not yet polled.
  await recordAgentJobObservation(data, { processInstanceKey: "PI", jobType: key, worker: "old-worker", jobKey: "J1", now: "2026-11-22T00:00:00Z" });
  const r = await deliveryNodeSlaCheck(data, { processInstanceKey: "PI", activationJobType: key, jobType: "senior:feature", currentJobKey: "J2", sla: "PT1H", now: "2026-11-22T05:00:00Z" });
  assertEquals(r.expired, false);
  assertEquals(r.reason.includes("old-worker"), false);
  // Once the poller observes J2 activating, ITS activation (not J1's) drives the budget.
  await recordAgentJobObservation(data, { processInstanceKey: "PI", jobType: key, worker: "new-worker", jobKey: "J2", now: "2026-11-22T05:01:00Z" });
  const within = await deliveryNodeSlaCheck(data, { processInstanceKey: "PI", activationJobType: key, jobType: "senior:feature", currentJobKey: "J2", sla: "PT1H", now: "2026-11-22T05:30:00Z" });
  assertEquals(within.expired, false);
  const over = await deliveryNodeSlaCheck(data, { processInstanceKey: "PI", activationJobType: key, jobType: "senior:feature", currentJobKey: "J2", sla: "PT1H", now: "2026-11-22T06:01:00Z" });
  assertEquals(over.expired, true);
  assertStringIncludes(over.reason, "new-worker");
});

test("issue #1016 review: an unknown current job key (or a keyless ledger row) fails closed — never expired", async () => {
  const { data } = memDataFor(MIG);
  await recordAgentJobObservation(data, { processInstanceKey: "PI", jobType: key, worker: "w", jobKey: "J1", now: "2026-11-22T00:00:00Z" });
  const unknown = await deliveryNodeSlaCheck(data, { processInstanceKey: "PI", activationJobType: key, jobType: "senior:feature", currentJobKey: null, sla: "PT1H", now: "2026-11-22T05:00:00Z" });
  assertEquals(unknown.expired, false);
  const { data: d2 } = memDataFor(MIG);
  await recordAgentJobObservation(d2, { processInstanceKey: "PI", jobType: key, worker: "w", jobKey: null, now: "2026-11-22T00:00:00Z" });
  const keyless = await deliveryNodeSlaCheck(d2, { processInstanceKey: "PI", activationJobType: key, jobType: "senior:feature", currentJobKey: "J1", sla: "PT1H", now: "2026-11-22T05:00:00Z" });
  assertEquals(keyless.expired, false);
});

test("currentWatchedJobKey pins exactly one live job of the watched element, else null", async () => {
  const mk = (jobs: { jobKey: string; elementId?: string }[] | Error) => ({
    searchJobs: async () => {
      if (jobs instanceof Error) throw jobs;
      return jobs.map((j) => ({ type: "senior:feature", state: "CREATED", processInstanceKey: "PI", ...j }));
    },
  });
  assertEquals(await currentWatchedJobKey(mk([{ jobKey: "J2", elementId: "n0_task" }]), "PI", "n0_task"), "J2");
  assertEquals(await currentWatchedJobKey(mk([]), "PI", "n0_task"), null);
  assertEquals(await currentWatchedJobKey(mk([{ jobKey: "A" }, { jobKey: "B" }]), "PI", "n0_task"), null);
  assertEquals(await currentWatchedJobKey(mk([{ jobKey: "X", elementId: "other_task" }]), "PI", "n0_task"), null);
  assertEquals(await currentWatchedJobKey(mk(new Error("down")), "PI", "n0_task"), null);
  assertEquals(await currentWatchedJobKey(mk([{ jobKey: "J2" }]), "", "n0_task"), null);
});

test("issue #1016 review: the SLA check cadence is capped independently of the SLA", () => {
  assertEquals(agentSlaCheckEvery("PT2H"), AGENT_SLA_CHECK_MAX_INTERVAL);
  assertEquals(agentSlaCheckEvery("PT1M"), "PT1M");
  assertEquals(agentSlaCheckEvery(AGENT_SLA_CHECK_MAX_INTERVAL), AGENT_SLA_CHECK_MAX_INTERVAL);
  // Zero-length budgets must never become a zero-delay re-firing cadence.
  for (const zero of ["PT0S", "P0D", "PT0M", "PT0H"]) assertEquals(agentSlaCheckEvery(zero), AGENT_SLA_CHECK_MAX_INTERVAL, zero);
});

test("watchedTaskElement maps the check element to the agent leaf", () => {
  assertEquals(watchedTaskElement("n0_slaChk"), "n0_task");
});

test("poll records delivery-graph agent jobs under a node-qualified key (parallel same-type nodes stay distinct)", async () => {
  const { data } = memDataFor(MIG);
  const items = [
    { type: "senior:feature", processInstanceKey: "PI", processDefinitionId: "delivery-graph-abc", elementId: "n0_task", jobKey: "A", worker: "w1", state: "CREATED" },
    { type: "senior:feature", processInstanceKey: "PI", processDefinitionId: "delivery-graph-abc", elementId: "n1_task", jobKey: "B", state: "CREATED" },
    { type: "senior:feature", processInstanceKey: "PX", processDefinitionId: "other", elementId: "x_task", jobKey: "C", state: "CREATED" },
  ];
  const prev = globalThis.fetch;
  globalThis.fetch = ((_u: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    const out = body.filter?.type ? [] : items;
    return Promise.resolve(new Response(JSON.stringify({ items: out }), { status: 200 }));
  }) as typeof fetch;
  try {
    await pollAgentActivationsImpl(data, "http://engine/v2", {});
  } finally {
    globalThis.fetch = prev;
  }
  assertEquals((await getAgentJobActivation(data, "PI", deliveryNodeActivationJobType("senior:feature", "n0_task")))?.worker, "w1");
  assertEquals((await getAgentJobActivation(data, "PI", deliveryNodeActivationJobType("senior:feature", "n1_task")))?.activated_at, null);
  assertEquals(await getAgentJobActivation(data, "PX", deliveryNodeActivationJobType("senior:feature", "x_task")), undefined);
});

test("an unchanged re-observation does not rewrite the row (no per-pass write churn)", async () => {
  const { data } = memDataFor(MIG);
  await recordAgentJobObservation(data, { processInstanceKey: "PI", jobType: key, worker: null, jobKey: "J1", now: "2026-11-22T00:00:00Z" });
  await recordAgentJobObservation(data, { processInstanceKey: "PI", jobType: key, worker: null, jobKey: "J1", now: "2026-11-22T00:59:00Z" });
  assertEquals((await getAgentJobActivation(data, "PI", key))?.updated_at, "2026-11-22T00:00:00Z");
});
