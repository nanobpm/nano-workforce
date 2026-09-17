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

test("protocolsFor: one bounded IN query maps each ORIGINAL key back, skips blanks, short-circuits empty", async () => {
  // The hot-path read is a single bounded `WHERE instance IN (…)` over the live set (not a per-worker
  // findOne / O(history) scan): assert it maps each key back correctly and handles the edge sets.
  const { data } = memDataFor(MIGRATIONS);
  const reg = new HarnessProtocolRegistry(data);
  await reg.recordEnrolment("a", 3);
  await reg.recordEnrolment("b", undefined); // NULL row → undefined
  // "c" never enrolled.
  const got = await reg.protocolsFor(["a", "b", "c", "   "]);
  assertEquals(got.get("a"), 3);
  assertEquals(got.get("b"), undefined);
  assertEquals(got.get("c"), undefined);
  assertEquals(got.has("   "), false, "a blank instance keys no row and is skipped");
  // An empty (or all-blank) set short-circuits without issuing an `IN ()` query.
  assertEquals((await reg.protocolsFor([])).size, 0);
  assertEquals((await reg.protocolsFor(["  "])).size, 0);
});

test("protocolsFor chunks past SQLite's host-parameter cap (a large fleet does not overflow one IN query)", async () => {
  // A fleet larger than a single IN(…) batch must still resolve every key: the read is chunked under
  // SQLite's ~999 host-parameter floor, so scale never throws (which the caller would mislabel as a
  // fleet-wide outage marking everyone stale). Exercise > 900 (two batches) plus a boundary key.
  const { data } = memDataFor(MIGRATIONS);
  const reg = new HarnessProtocolRegistry(data);
  const instances: string[] = [];
  for (let i = 0; i < 1500; i++) {
    const id = `wk-${i}`;
    instances.push(id);
    if (i % 2 === 0) await reg.recordEnrolment(id, 2); // even = enrolled@2, odd = never enrolled
  }
  const got = await reg.protocolsFor(instances);
  assertEquals(got.size, 1500, "every requested key is mapped back across batches");
  assertEquals(got.get("wk-0"), 2);
  assertEquals(got.get("wk-900"), 2, "a key in the second batch still resolves");
  assertEquals(got.get("wk-1"), undefined, "a never-enrolled key reads back undefined");
  assertEquals(got.get("wk-1499"), undefined);
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
