// Tests for the harness-protocol enrolment gate (issue #802) — the env knobs, the staleness
// derivation, and the durable registry over `worker_harness_protocol` (migration 107).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import {
  assessWorkers,
  assessWorkersWithAvailability,
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

test("minHarnessProtocol rejects parseInt-lenient values (Copilot #802): '3junk'/'1.9'/blank → default", () => {
  // `Number.parseInt` would accept "3junk" (→ 3) and truncate "1.9" (→ 1); a strict integer parse
  // degrades all of these to the registered default so a malformed knob never silently shifts the gate.
  assertEquals(minHarnessProtocol({ NANO_AGENTIC_MIN_HARNESS_PROTOCOL: "3junk" }), 1);
  assertEquals(minHarnessProtocol({ NANO_AGENTIC_MIN_HARNESS_PROTOCOL: "1.9" }), 1);
  assertEquals(minHarnessProtocol({ NANO_AGENTIC_MIN_HARNESS_PROTOCOL: "" }), 1);
  assertEquals(minHarnessProtocol({ NANO_AGENTIC_MIN_HARNESS_PROTOCOL: "  " }), 1);
  assertEquals(minHarnessProtocol({ NANO_AGENTIC_MIN_HARNESS_PROTOCOL: "-2" }), 1);
  // A clean integer (with surrounding whitespace) still parses.
  assertEquals(minHarnessProtocol({ NANO_AGENTIC_MIN_HARNESS_PROTOCOL: " 4 " }), 4);
  assertEquals(minHarnessProtocol({ NANO_AGENTIC_MIN_HARNESS_PROTOCOL: "0" }), 0);
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

test("assessWorkersWithAvailability: registryAvailable is true on a successful read, false without a data layer", async () => {
  const { data } = memDataFor(MIGRATIONS);
  await new HarnessProtocolRegistry(data).recordEnrolment("healthy", 2);
  const ok = await assessWorkersWithAvailability(data, ["healthy"], { NANO_AGENTIC_MIN_HARNESS_PROTOCOL: "1" });
  assertEquals(ok.registryAvailable, true);
  assertEquals(ok.assessments.get("healthy")?.stale, false);

  const noData = await assessWorkersWithAvailability(undefined, ["healthy"]);
  assertEquals(noData.registryAvailable, false, "no data layer = registry could not be consulted");
  assertEquals(noData.assessments.get("healthy")?.stale, true, "still fails loud per-worker");
});

test("assessWorkersWithAvailability: a registry read outage reports registryAvailable=false (not silent all-stale)", async () => {
  // A legacy DB predating migration 107: the table is absent, so the bounded read throws and is caught.
  const { data } = memDataFor([]);
  const res = await assessWorkersWithAvailability(data, ["a", "b"]);
  assertEquals(res.registryAvailable, false, "read failure surfaces as unavailable, distinct from all-healthy");
  assertEquals(res.assessments.get("a")?.stale, true, "assessments still fail loud");
});

test("protocolsFor reads only the requested instances (bounded), not the whole history", async () => {
  const { data } = memDataFor(MIGRATIONS);
  const reg = new HarnessProtocolRegistry(data);
  await reg.recordEnrolment("live-1", 2);
  await reg.recordEnrolment("live-2", undefined);
  await reg.recordEnrolment("disconnected-history", 3);
  const scoped = await reg.protocolsFor(["live-1", "live-2", "never-enrolled"]);
  assertEquals(scoped.get("live-1"), 2);
  assertEquals(scoped.get("live-2"), undefined, "an enrolled-but-versionless row reads as undefined");
  assertEquals(scoped.get("never-enrolled"), undefined, "an absent row reads as undefined");
  assertEquals(scoped.has("disconnected-history"), false, "a historical instance outside the live set is never read");
});
