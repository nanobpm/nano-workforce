// Issue #879: the activation ledger upsert must capture the FIRST activation only, be idempotent on a
// steady state, and never move/clear an earlier activation timestamp — so the SLA escalation reads a
// stable never-started-vs-activated signal regardless of how many poll passes observe the job.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { getAgentJobActivation, recordAgentJobObservation } from "./agentActivationLedger.ts";
import { memDataFor } from "../test/worldDb.ts";

function ledger() {
  return memDataFor(["119_agent_job_activations.sql"]).data;
}

test("first observation of a queued job records first_seen_at, no activation", async () => {
  const data = ledger();
  await recordAgentJobObservation(data, {
    processInstanceKey: "PI-1",
    jobType: "senior:feature",
    worker: null,
    now: "t0",
  });
  const row = await getAgentJobActivation(data, "PI-1", "senior:feature");
  assertEquals(row?.first_seen_at, "t0");
  assertEquals(row?.activated_at, null);
  assertEquals(row?.worker, null);
});

test("a later observation with a worker records the activation", async () => {
  const data = ledger();
  await recordAgentJobObservation(data, { processInstanceKey: "PI-2", jobType: "senior:feature", worker: null, now: "t0" });
  await recordAgentJobObservation(data, {
    processInstanceKey: "PI-2",
    jobType: "senior:feature",
    worker: "agent-a",
    now: "t1",
  });
  const row = await getAgentJobActivation(data, "PI-2", "senior:feature");
  assertEquals(row?.first_seen_at, "t0");
  assertEquals(row?.activated_at, "t1");
  assertEquals(row?.worker, "agent-a");
});

test("the FIRST activation is sticky — a later re-observation never moves it", async () => {
  const data = ledger();
  await recordAgentJobObservation(data, { processInstanceKey: "PI-3", jobType: "senior:feature", worker: "agent-a", now: "t1" });
  await recordAgentJobObservation(data, { processInstanceKey: "PI-3", jobType: "senior:feature", worker: "agent-b", now: "t2" });
  const row = await getAgentJobActivation(data, "PI-3", "senior:feature");
  assertEquals(row?.activated_at, "t1");
  assertEquals(row?.worker, "agent-a");
});

test("observations are keyed by (instance, jobType) — distinct jobs do not collide", async () => {
  const data = ledger();
  await recordAgentJobObservation(data, { processInstanceKey: "PI-4", jobType: "senior:conformance", worker: null, now: "t0" });
  await recordAgentJobObservation(data, { processInstanceKey: "PI-4", jobType: "senior:retro", worker: "agent-c", now: "t0" });
  const conf = await getAgentJobActivation(data, "PI-4", "senior:conformance");
  const retro = await getAgentJobActivation(data, "PI-4", "senior:retro");
  assertEquals(conf?.activated_at, null);
  assertEquals(retro?.worker, "agent-c");
});

test("an empty-string worker is treated as not-yet-activated", async () => {
  const data = ledger();
  await recordAgentJobObservation(data, { processInstanceKey: "PI-5", jobType: "senior:feature", worker: "", now: "t0" });
  const row = await getAgentJobActivation(data, "PI-5", "senior:feature");
  assertEquals(row?.activated_at, null);
  assertEquals(row?.worker, null);
});
