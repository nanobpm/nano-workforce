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

test("a new job key (a retry) RESETS the row — an activated attempt followed by an unactivated retry reads never-activated", async () => {
  // Issue #879 review: implement-cell/merge-cell/merge-loop retry the SAME (instance, jobType), so a
  // sticky first-activation would make a queued retry read the EARLIER attempt's worker and misdiagnose
  // it as started/hung. The attempt's engine jobKey discriminates them.
  const data = ledger();
  // Attempt 1: activated by agent-a.
  await recordAgentJobObservation(data, { processInstanceKey: "PI-6", jobType: "senior:feature", worker: "agent-a", jobKey: "J1", now: "t1" });
  // A steady re-observation of the SAME attempt never moves the first activation.
  await recordAgentJobObservation(data, { processInstanceKey: "PI-6", jobType: "senior:feature", worker: "agent-a", jobKey: "J1", now: "t2" });
  let row = await getAgentJobActivation(data, "PI-6", "senior:feature");
  assertEquals(row?.activated_at, "t1");
  assertEquals(row?.worker, "agent-a");
  // Attempt 2 (retry): a DIFFERENT jobKey, still queued → the row resets to the current attempt.
  await recordAgentJobObservation(data, { processInstanceKey: "PI-6", jobType: "senior:feature", worker: null, jobKey: "J2", now: "t3" });
  row = await getAgentJobActivation(data, "PI-6", "senior:feature");
  assertEquals(row?.first_seen_at, "t3");
  assertEquals(row?.activated_at, null);
  assertEquals(row?.worker, null);
  assertEquals(row?.job_key, "J2");
});

test("a new job key that is itself activated reflects the CURRENT attempt's worker, not the prior one", async () => {
  const data = ledger();
  await recordAgentJobObservation(data, { processInstanceKey: "PI-7", jobType: "senior:trial-merge", worker: "agent-a", jobKey: "J1", now: "t1" });
  await recordAgentJobObservation(data, { processInstanceKey: "PI-7", jobType: "senior:trial-merge", worker: "agent-b", jobKey: "J2", now: "t2" });
  const row = await getAgentJobActivation(data, "PI-7", "senior:trial-merge");
  assertEquals(row?.activated_at, "t2");
  assertEquals(row?.worker, "agent-b");
  assertEquals(row?.job_key, "J2");
});

test("the SAME job key keeps the first-activation sticky across re-observations", async () => {
  const data = ledger();
  await recordAgentJobObservation(data, { processInstanceKey: "PI-8", jobType: "senior:feature", worker: null, jobKey: "J1", now: "t0" });
  await recordAgentJobObservation(data, { processInstanceKey: "PI-8", jobType: "senior:feature", worker: "agent-a", jobKey: "J1", now: "t1" });
  await recordAgentJobObservation(data, { processInstanceKey: "PI-8", jobType: "senior:feature", worker: "agent-b", jobKey: "J1", now: "t2" });
  const row = await getAgentJobActivation(data, "PI-8", "senior:feature");
  assertEquals(row?.first_seen_at, "t0");
  assertEquals(row?.activated_at, "t1");
  assertEquals(row?.worker, "agent-a");
});
