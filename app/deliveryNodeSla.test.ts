// Issue #1016: a delivery-graph agent node's work SLA must not count queue time. The poller records each
// delivery node's job activation under a node-qualified ledger key, and `deliveryNodeSlaCheck` reports the
// work SLA expired ONLY once it has elapsed since activation, with a reason stating the facts.
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "#test-assert";
import { deliveryNodeActivationJobType, getAgentJobActivation, recordAgentJobObservation } from "./agentActivationLedger.ts";
import { deliveryNodeSlaCheck } from "./agentSlaEscalation.ts";
import { pollAgentActivationsImpl } from "./service.ts";
import { watchedTaskElement } from "../workers/agent-sla-check/worker.ts";
import { memDataFor } from "../test/worldDb.ts";

const MIG = ["119_agent_job_activations.sql"];
const key = deliveryNodeActivationJobType("senior:feature", "n0_task");

test("never-activated delivery node job → not expired (queue time never escalates)", async () => {
  const { data } = memDataFor(MIG);
  await recordAgentJobObservation(data, { processInstanceKey: "PI", jobType: key, worker: null, jobKey: "J1", now: "2026-11-22T00:00:00Z" });
  const r = await deliveryNodeSlaCheck(data, { processInstanceKey: "PI", activationJobType: key, jobType: "senior:feature", sla: "PT1H", now: "2026-11-22T05:00:00Z" });
  assertEquals(r.expired, false);
});

test("unobserved delivery node job → not expired (activation not provable, nothing is cancelled)", async () => {
  const { data } = memDataFor(MIG);
  const r = await deliveryNodeSlaCheck(data, { processInstanceKey: "PI", activationJobType: key, jobType: "senior:feature", sla: "PT1H" });
  assertEquals(r.expired, false);
});

test("activated shortly before the ENTRY deadline → full work budget from activation, then escalate with the facts", async () => {
  const { data } = memDataFor(MIG);
  await recordAgentJobObservation(data, { processInstanceKey: "PI", jobType: key, worker: null, jobKey: "J1", now: "2026-11-22T00:00:00Z" });
  await recordAgentJobObservation(data, { processInstanceKey: "PI", jobType: key, worker: "merlin-1", jobKey: "J1", now: "2026-11-22T00:59:00Z" });
  // The entry-anchored boundary fires at 01:00 — one minute into the work: must NOT expire.
  const early = await deliveryNodeSlaCheck(data, { processInstanceKey: "PI", activationJobType: key, jobType: "senior:feature", sla: "PT1H", now: "2026-11-22T01:00:00Z" });
  assertEquals(early.expired, false);
  const late = await deliveryNodeSlaCheck(data, { processInstanceKey: "PI", activationJobType: key, jobType: "senior:feature", sla: "PT1H", now: "2026-11-22T02:00:00Z" });
  assertEquals(late.expired, true);
  assertStringIncludes(late.reason, "merlin-1");
  assertStringIncludes(late.reason, "2026-11-22T00:59:00Z");
  assertEquals(late.reason.includes("may already exist"), false);
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

test("re-observation refreshes updated_at so a polled-queued job stays fresh", async () => {
  const { data } = memDataFor(MIG);
  await recordAgentJobObservation(data, { processInstanceKey: "PI", jobType: key, worker: null, jobKey: "J1", now: "2026-11-22T00:00:00Z" });
  await recordAgentJobObservation(data, { processInstanceKey: "PI", jobType: key, worker: null, jobKey: "J1", now: "2026-11-22T00:59:00Z" });
  assertEquals((await getAgentJobActivation(data, "PI", key))?.updated_at, "2026-11-22T00:59:00Z");
});
