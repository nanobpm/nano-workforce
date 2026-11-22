// Issue #1016: a delivery-graph agent node's work SLA must not count queue time. The poller records each
// delivery node's job activation under a node-qualified ledger key, and `deliveryNodeSlaCheck` decides
// re-queue (never activated) vs escalate (activated / unknown) with a reason stating the facts.
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "#test-assert";
import { deliveryNodeActivationJobType, getAgentJobActivation, recordAgentJobObservation } from "./agentActivationLedger.ts";
import { deliveryNodeSlaCheck } from "./agentSlaEscalation.ts";
import { pollAgentActivationsImpl } from "./service.ts";
import { watchedTaskElement } from "../workers/agent-sla-check/worker.ts";
import { memDataFor } from "../test/worldDb.ts";

const MIG = ["119_agent_job_activations.sql"];
const key = deliveryNodeActivationJobType("senior:feature", "n0_task");

test("never-activated delivery node job → re-queue, no escalation", async () => {
  const { data } = memDataFor(MIG);
  await recordAgentJobObservation(data, { processInstanceKey: "PI", jobType: key, worker: null, jobKey: "J1", now: "2026-11-22T00:00:00Z" });
  const r = await deliveryNodeSlaCheck(data, { processInstanceKey: "PI", activationJobType: key, jobType: "senior:feature", sla: "PT1H", now: "2026-11-22T01:00:00Z" });
  assertEquals(r.requeue, true);
});

test("activated delivery node job → escalate with worker + activation time, not 'may already exist'", async () => {
  const { data } = memDataFor(MIG);
  await recordAgentJobObservation(data, { processInstanceKey: "PI", jobType: key, worker: null, jobKey: "J1", now: "2026-11-22T00:00:00Z" });
  await recordAgentJobObservation(data, { processInstanceKey: "PI", jobType: key, worker: "merlin-1", jobKey: "J1", now: "2026-11-22T00:10:00Z" });
  const r = await deliveryNodeSlaCheck(data, { processInstanceKey: "PI", activationJobType: key, jobType: "senior:feature", sla: "PT1H", now: "2026-11-22T01:00:00Z" });
  assertEquals(r.requeue, false);
  assertStringIncludes(r.reason, "merlin-1");
  assertStringIncludes(r.reason, "2026-11-22T00:10:00Z");
  assertEquals(r.reason.includes("may already exist"), false);
});

test("unobserved delivery node job → escalate with honest 'unknown' wording (not proof of non-activation)", async () => {
  const { data } = memDataFor(MIG);
  const r = await deliveryNodeSlaCheck(data, { processInstanceKey: "PI", activationJobType: key, jobType: "senior:feature", sla: "PT1H" });
  assertEquals(r.requeue, false);
  assertStringIncludes(r.reason, "cannot confirm");
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
