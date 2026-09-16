// Tests for the harness-protocol enrolment gate (issue #802) — the env knobs, the staleness
// derivation, and the durable registry over `worker_harness_protocol` (migration 107).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import {
  assessWorkers,
  HarnessProtocolRegistry,
  isStaleProtocol,
  minHarnessProtocol,
  staleHarnessPolicy,
} from "./harnessProtocol.ts";
import { memDataFor } from "../test/worldDb.ts";

const MIGRATIONS = ["107_worker_harness_protocol.sql"];

test("minHarnessProtocol defaults to 1 and reads the declared env knob", () => {
  assertEquals(minHarnessProtocol({}), 1);
  assertEquals(minHarnessProtocol({ NANO_AGENTIC_MIN_HARNESS_PROTOCOL: "3" }), 3);
  // A malformed/blank value degrades to the default rather than NaN-poisoning the gate.
  assertEquals(minHarnessProtocol({ NANO_AGENTIC_MIN_HARNESS_PROTOCOL: "nonsense" }), 1);
});

test("staleHarnessPolicy defaults to flag; only the exact 'refuse' token opts into refusal", () => {
  assertEquals(staleHarnessPolicy({}), "flag");
  assertEquals(staleHarnessPolicy({ NANO_AGENTIC_STALE_HARNESS_POLICY: "refuse" }), "refuse");
  assertEquals(staleHarnessPolicy({ NANO_AGENTIC_STALE_HARNESS_POLICY: "  REFUSE " }), "refuse");
  assertEquals(staleHarnessPolicy({ NANO_AGENTIC_STALE_HARNESS_POLICY: "flagg" }), "flag");
});

test("isStaleProtocol: absent version is stale; below-minimum is stale; at-or-above is healthy", () => {
  assertEquals(isStaleProtocol(undefined, 1), true, "no version advertised = stale");
  assertEquals(isStaleProtocol(null, 1), true, "null version = stale");
  assertEquals(isStaleProtocol(0, 1), true, "below minimum = stale");
  assertEquals(isStaleProtocol(1, 1), false, "at minimum = healthy");
  assertEquals(isStaleProtocol(5, 1), false, "above minimum = healthy");
});

test("registry records the advertised protocol and reads it back (idempotent upsert)", async () => {
  const { data } = memDataFor(MIGRATIONS);
  const reg = new HarnessProtocolRegistry(data);
  await reg.recordEnrolment("wk-1", 2);
  assertEquals(await reg.protocolFor("wk-1"), 2);
  // Re-enrol overwrites (upsert keyed by instance).
  await reg.recordEnrolment("wk-1", 4);
  assertEquals(await reg.protocolFor("wk-1"), 4);
});

test("a downgrade re-enrol WITHOUT a version clears a stale-healthy value to absent (stale)", async () => {
  const { data } = memDataFor(MIGRATIONS);
  const reg = new HarnessProtocolRegistry(data);
  await reg.recordEnrolment("wk-1", 3);
  assertEquals(await reg.protocolFor("wk-1"), 3);
  await reg.recordEnrolment("wk-1", undefined);
  assertEquals(await reg.protocolFor("wk-1"), undefined, "stale-healthy value cleared to NULL");
});

test("a blank/whitespace instance is a no-op (no unreachable/colliding row)", async () => {
  const { data } = memDataFor(MIGRATIONS);
  const reg = new HarnessProtocolRegistry(data);
  await reg.recordEnrolment("   ", 2);
  assertEquals((await reg.all()).size, 0);
});

test("assessWorkers: flags absent/below-min as stale, at-or-above as healthy (canonical derivation)", async () => {
  const { data } = memDataFor(MIGRATIONS);
  const reg = new HarnessProtocolRegistry(data);
  await reg.recordEnrolment("healthy", 2);
  await reg.recordEnrolment("old", 0);
  await reg.recordEnrolment("versionless", undefined);
  // "never-enrolled" has no row at all.
  const out = await assessWorkers(data, ["healthy", "old", "versionless", "never-enrolled"], {
    NANO_AGENTIC_MIN_HARNESS_PROTOCOL: "1",
  });
  assertEquals(out.get("healthy"), { instance: "healthy", harnessProtocol: 2, stale: false });
  assertEquals(out.get("old"), { instance: "old", harnessProtocol: 0, stale: true });
  assertEquals(out.get("versionless"), { instance: "versionless", stale: true });
  assertEquals(out.get("never-enrolled"), { instance: "never-enrolled", stale: true });
});

test("assessWorkers with no data layer treats every worker as stale (fail loud)", async () => {
  const out = await assessWorkers(undefined, ["a", "b"]);
  assertEquals(out.get("a")?.stale, true);
  assertEquals(out.get("b")?.stale, true);
  assert(!("harnessProtocol" in (out.get("a") ?? {})), "no protocol known without a registry");
});
