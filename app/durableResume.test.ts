// Tests for the `durable-resume` enrolment registry (issue #325, ADR 0062 Slice 5/5) against a REAL
// in-memory SQLite engine with migration 052 applied — so the upsert, the {0,1} flag domain, and the
// fleet-level participation probe are proven, not mocked.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { memDataFor } from "../test/worldDb.ts";
import { DurableResumeRegistry, DURABLE_RESUME_ATTR, fleetSupportsDurableResume } from "./durableResume.ts";

const mem = () => memDataFor(["052_worker_durable_resume.sql"]);

test("DURABLE_RESUME_ATTR is the canonical enrolment-attribute name", () => {
  assertEquals(DURABLE_RESUME_ATTR, "durable-resume");
});

test("recordEnrolment persists a participant and isParticipant reads it back", async () => {
  const { data } = mem();
  const reg = new DurableResumeRegistry(data);
  assertEquals(await reg.isParticipant("w1"), false, "unknown instance is a non-participant (safe default)");
  await reg.recordEnrolment("w1", true);
  assertEquals(await reg.isParticipant("w1"), true);
});

test("recordEnrolment records an explicit non-participant as false", async () => {
  const { data } = mem();
  const reg = new DurableResumeRegistry(data);
  await reg.recordEnrolment("w1", false);
  assertEquals(await reg.isParticipant("w1"), false);
  assertEquals(await reg.anyParticipant(), false, "a recorded non-participant is not a participant");
});

test("recordEnrolment is an idempotent upsert — a re-enrol overwrites the flag", async () => {
  const { data } = mem();
  const reg = new DurableResumeRegistry(data);
  await reg.recordEnrolment("w1", true);
  assertEquals(await reg.isParticipant("w1"), true);
  // A redeploy that drops durable-resume support flips the flag back — no duplicate row, no stale yes.
  await reg.recordEnrolment("w1", false);
  assertEquals(await reg.isParticipant("w1"), false);
  await reg.recordEnrolment("w1", true);
  assertEquals(await reg.isParticipant("w1"), true);
});

test("anyParticipant is the fleet-level existence probe over participants", async () => {
  const { data } = mem();
  const reg = new DurableResumeRegistry(data);
  assertEquals(await reg.anyParticipant(), false, "no enrolment yet");
  await reg.recordEnrolment("legacy-1", false);
  await reg.recordEnrolment("legacy-2", false);
  assertEquals(await reg.anyParticipant(), false, "a fleet of only non-participants does not support resume");
  await reg.recordEnrolment("modern-1", true);
  assertEquals(await reg.anyParticipant(), true, "one participant makes the mixed fleet resume-capable");
});

test("fleetSupportsDurableResume mirrors anyParticipant, and degrades to false without a data layer", async () => {
  const { data } = mem();
  assertEquals(await fleetSupportsDurableResume(undefined), false, "no data layer → additive-safe false");
  assertEquals(await fleetSupportsDurableResume(data), false, "no participant enrolled");
  await new DurableResumeRegistry(data).recordEnrolment("w1", true);
  assertEquals(await fleetSupportsDurableResume(data), true);
});

test("fleetSupportsDurableResume degrades to false on a store read failure (legacy DB predating 052)", async () => {
  // A DataLayer whose table has no `worker_durable_resume` — the read throws; the gate must degrade to
  // false (redrive from scratch) rather than blocking a submit/merge on the enrolment registry.
  const { data } = memDataFor([]);
  assertEquals(await fleetSupportsDurableResume(data), false);
});

test("the flag domain is pinned to {0,1} — a participant reads as exactly true", async () => {
  const { data, db } = mem();
  await new DurableResumeRegistry(data).recordEnrolment("w1", true);
  const rows = db.prepare("SELECT durable_resume FROM worker_durable_resume WHERE instance = ?").all("w1");
  assertEquals(rows.length, 1);
  assert(rows[0].durable_resume === 1, "true is stored as the integer 1");
});
