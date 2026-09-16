// Tests for POST /app/api/agentic/enrol → operation `enrolAgenticWorker` (epic #152 / N1 #145).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { memDataFor } from "../test/worldDb.ts";
import { DurableResumeRegistry } from "../app/durableResume.ts";
import { HarnessProtocolRegistry } from "../app/harnessProtocol.ts";
import { noopLog } from "../test/log.ts";
import handler from "./enrolAgenticWorker.ts";

const app = { log: noopLog() } as unknown as AppApi;

function input(body: unknown, headers: Record<string, string> = {}) {
  return {
    req: { method: "POST", path: "/app/api/agentic/enrol", query: new URLSearchParams(), headers: new Headers(headers), text: async () => JSON.stringify(body) } as any,
    params: {},
    query: {},
    body: body as any,
  };
}

test("resolves a declared capability to its SERVE set", async () => {
  const res = (await handler(input({ capability: { cognition: "planning", weight: 5, family: "frontier" }, instance: "w1" }), app)) as any;
  assertEquals(res.status, 200);
  assert(res.body.serve.includes("planning.spar"));
  assertEquals(res.body.instance, "w1");
  assert(typeof res.body.demandVersion === "number");
  assert(typeof res.body.leaseTtl === "number");
});

test("folds a top-level host into the capability when the capability has none", async () => {
  const res = (await handler(input({ capability: { cognition: "ci" }, host: "runner-box" }), app)) as any;
  assertEquals(res.status, 200);
  // ci.runner has no host requires gate, so the fold does not change the SERVE set — assert it resolves.
  assert(res.body.serve.includes("ci.runner"));
});

test("rejects a body with no capability as 400", async () => {
  const res = (await handler(input({ host: "x" }), app)) as any;
  assertEquals(res.status, 400);
});

test("rejects an array body or array capability as 400", async () => {
  const arrayBody = (await handler(input([]), app)) as any;
  assertEquals(arrayBody.status, 400);
  const arrayCapability = (await handler(input({ capability: [] }), app)) as any;
  assertEquals(arrayCapability.status, 400);
});

test("rejects non-string optional fields (host / capability.host / instance) as 400", async () => {
  const badHost = (await handler(input({ capability: { cognition: "ci" }, host: 42 }), app)) as any;
  assertEquals(badHost.status, 400);
  const badCapHost = (await handler(input({ capability: { cognition: "ci", host: { nested: true } } }), app)) as any;
  assertEquals(badCapHost.status, 400);
  const badInstance = (await handler(input({ capability: { cognition: "ci" }, instance: 7 }), app)) as any;
  assertEquals(badInstance.status, 400);
});

test("rejects malformed capability fields (non-string cognition/family, non-number weight) as 400", async () => {
  const badCognition = (await handler(input({ capability: { cognition: 7 } }), app)) as any;
  assertEquals(badCognition.status, 400);
  const badFamily = (await handler(input({ capability: { cognition: "ci", family: ["frontier"] } }), app)) as any;
  assertEquals(badFamily.status, 400);
  const badWeight = (await handler(input({ capability: { cognition: "planning", weight: "5" } }), app)) as any;
  assertEquals(badWeight.status, 400);
});

test("rejects non-finite capability.weight (NaN/Infinity) as 400", async () => {
  const nanWeight = (await handler(input({ capability: { cognition: "planning", weight: Number.NaN } }), app)) as any;
  assertEquals(nanWeight.status, 400);
  const infWeight = (await handler(input({ capability: { cognition: "planning", weight: Number.POSITIVE_INFINITY } }), app)) as any;
  assertEquals(infWeight.status, 400);
});

// Durable-resume enrolment gate (issue #325, ADR 0062 Slice 5/5).
test("echoes durableResume back in the result when the worker declares it", async () => {
  const on = (await handler(input({ capability: { cognition: "decide" }, instance: "w1", durableResume: true }), app)) as any;
  assertEquals(on.status, 200);
  assertEquals(on.body.durableResume, true);
  const off = (await handler(input({ capability: { cognition: "decide" }, instance: "w2", durableResume: false }), app)) as any;
  assertEquals(off.body.durableResume, false);
});

test("omits durableResume from the result when the worker does not declare it", async () => {
  const res = (await handler(input({ capability: { cognition: "decide" }, instance: "w1" }), app)) as any;
  assertEquals(res.status, 200);
  assertEquals("durableResume" in res.body, false);
});

test("rejects a non-boolean durableResume as 400", async () => {
  const res = (await handler(input({ capability: { cognition: "decide" }, instance: "w1", durableResume: "yes" }), app)) as any;
  assertEquals(res.status, 400);
});

test("records durable-resume participation in the registry when a data layer + instance are present", async () => {
  const { data } = memDataFor(["052_worker_durable_resume.sql"]);
  const withData = { log: noopLog(), data } as unknown as AppApi;
  const res = (await handler(input({ capability: { cognition: "decide" }, instance: "w1", durableResume: true }), withData)) as any;
  assertEquals(res.status, 200);
  assertEquals(await new DurableResumeRegistry(data).isParticipant("w1"), true);
  assertEquals(await new DurableResumeRegistry(data).anyParticipant(), true);
});

test("a re-enrol omitting durableResume persists an explicit false, clearing a stale true (degrade to scratch)", async () => {
  const { data } = memDataFor(["052_worker_durable_resume.sql"]);
  const withData = { log: noopLog(), data } as unknown as AppApi;
  // First enrol advertises durable-resume.
  await handler(input({ capability: { cognition: "decide" }, instance: "w1", durableResume: true }), withData);
  assertEquals(await new DurableResumeRegistry(data).isParticipant("w1"), true);
  // Re-enrol WITHOUT the field (downgrade/rollback/client bug) must clear the stale flag.
  const res = (await handler(input({ capability: { cognition: "decide" }, instance: "w1" }), withData)) as any;
  assertEquals(res.status, 200);
  assertEquals("durableResume" in res.body, false, "still omitted from the echo");
  assertEquals(await new DurableResumeRegistry(data).isParticipant("w1"), false, "stale true cleared");
  assertEquals(await new DurableResumeRegistry(data).anyParticipant(), false);
});

test("a declaration without an instance is echoed but not persisted (enrolment is per-instance)", async () => {
  const { data } = memDataFor(["052_worker_durable_resume.sql"]);
  const withData = { log: noopLog(), data } as unknown as AppApi;
  const res = (await handler(input({ capability: { cognition: "decide" }, durableResume: true }), withData)) as any;
  assertEquals(res.status, 200);
  assertEquals(res.body.durableResume, true, "still echoed");
  assertEquals(await new DurableResumeRegistry(data).anyParticipant(), false, "nothing recorded without an instance key");
});

test("a blank/whitespace instance is echoed but not persisted (avoids a shared registry-row collision)", async () => {
  const { data } = memDataFor(["052_worker_durable_resume.sql"]);
  const withData = { log: noopLog(), data } as unknown as AppApi;
  const res = (await handler(input({ capability: { cognition: "decide" }, instance: "   ", durableResume: true }), withData)) as any;
  assertEquals(res.status, 200);
  assertEquals(res.body.instance, "   ", "still echoed verbatim");
  assertEquals(res.body.durableResume, true, "still echoed");
  assertEquals(await new DurableResumeRegistry(data).anyParticipant(), false, "nothing recorded for a blank instance key");
});

test("enforces the shared secret when NANO_PR_WEBHOOK_SECRET is set", async () => {
  // The module captures the secret at load, so re-import a cache-busted copy with the env var set to
  // exercise the guarded 401 path and the authorized 200 path.
  const prev = process.env["NANO_PR_WEBHOOK_SECRET"];
  process.env["NANO_PR_WEBHOOK_SECRET"] = "s3cr3t";
  try {
    const mod = await import(`./enrolAgenticWorker.ts?guard=${Date.now()}`);
    const guarded = mod.default as typeof handler;
    const bad = (await guarded(input({ capability: { cognition: "decide" } }), app)) as any;
    assertEquals(bad.status, 401);
    const ok = (await guarded(input({ capability: { cognition: "decide" } }, { "x-hook-secret": "s3cr3t" }), app)) as any;
    assertEquals(ok.status, 200);
    assert(ok.body.serve.includes("decide"));
  } finally {
    if (prev === undefined) delete process.env["NANO_PR_WEBHOOK_SECRET"];
    else process.env["NANO_PR_WEBHOOK_SECRET"] = prev;
  }
});

// Harness-protocol enrolment gate (issue #802).
const HARNESS_MIGRATIONS = ["052_worker_durable_resume.sql", "107_worker_harness_protocol.sql"];

test("echoes harnessProtocol and reports harnessStale=false for a healthy protocol (>= minimum)", async () => {
  const res = (await handler(input({ capability: { cognition: "decide" }, instance: "w1", harnessProtocol: 2 }), app)) as any;
  assertEquals(res.status, 200);
  assertEquals(res.body.harnessProtocol, 2);
  assertEquals(res.body.harnessStale, false);
  // No routing regression under the default `flag` policy: SERVE is unchanged.
  assert(res.body.serve.includes("decide"));
});

test("flags harnessStale=true when the harness advertises no version at all (absent = stale)", async () => {
  const res = (await handler(input({ capability: { cognition: "decide" }, instance: "w1" }), app)) as any;
  assertEquals(res.status, 200);
  assertEquals("harnessProtocol" in res.body, false, "no protocol echoed when none advertised");
  assertEquals(res.body.harnessStale, true);
  // Default `flag` policy: a stale harness is still routed (only flagged), so no fleet regression.
  assert(res.body.serve.includes("decide"), "flag policy leaves SERVE intact");
});

test("flags harnessStale=true for a below-minimum protocol", async () => {
  const prev = process.env["NANO_AGENTIC_MIN_HARNESS_PROTOCOL"];
  process.env["NANO_AGENTIC_MIN_HARNESS_PROTOCOL"] = "3";
  try {
    const res = (await handler(input({ capability: { cognition: "decide" }, instance: "w1", harnessProtocol: 1 }), app)) as any;
    assertEquals(res.status, 200);
    assertEquals(res.body.harnessStale, true);
  } finally {
    if (prev === undefined) delete process.env["NANO_AGENTIC_MIN_HARNESS_PROTOCOL"];
    else process.env["NANO_AGENTIC_MIN_HARNESS_PROTOCOL"] = prev;
  }
});

test("rejects a non-integer/negative harnessProtocol as 400", async () => {
  const nonInt = (await handler(input({ capability: { cognition: "decide" }, harnessProtocol: 1.5 }), app)) as any;
  assertEquals(nonInt.status, 400);
  const negative = (await handler(input({ capability: { cognition: "decide" }, harnessProtocol: -1 }), app)) as any;
  assertEquals(negative.status, 400);
  const str = (await handler(input({ capability: { cognition: "decide" }, harnessProtocol: "2" }), app)) as any;
  assertEquals(str.status, 400);
});

test("records the advertised harness protocol in the registry when a data layer + instance are present", async () => {
  const { data } = memDataFor(HARNESS_MIGRATIONS);
  const withData = { log: noopLog(), data } as unknown as AppApi;
  const res = (await handler(input({ capability: { cognition: "decide" }, instance: "w1", harnessProtocol: 2 }), withData)) as any;
  assertEquals(res.status, 200);
  assertEquals(await new HarnessProtocolRegistry(data).protocolFor("w1"), 2);
});

test("a re-enrol WITHOUT a protocol clears a stale-healthy recorded value (degrade to stale)", async () => {
  const { data } = memDataFor(HARNESS_MIGRATIONS);
  const withData = { log: noopLog(), data } as unknown as AppApi;
  await handler(input({ capability: { cognition: "decide" }, instance: "w1", harnessProtocol: 3 }), withData);
  assertEquals(await new HarnessProtocolRegistry(data).protocolFor("w1"), 3);
  const res = (await handler(input({ capability: { cognition: "decide" }, instance: "w1" }), withData)) as any;
  assertEquals(res.status, 200);
  assertEquals(await new HarnessProtocolRegistry(data).protocolFor("w1"), undefined, "stale-healthy value cleared");
});

test("under the `refuse` policy a stale harness is handed an EMPTY SERVE set (no job leases)", async () => {
  const prev = process.env["NANO_AGENTIC_STALE_HARNESS_POLICY"];
  process.env["NANO_AGENTIC_STALE_HARNESS_POLICY"] = "refuse";
  try {
    const mod = await import(`./enrolAgenticWorker.ts?refuse=${Date.now()}`);
    const guarded = mod.default as typeof handler;
    // A stale (version-less) worker: SERVE withheld.
    const stale = (await guarded(input({ capability: { cognition: "decide" }, instance: "w1" }), app)) as any;
    assertEquals(stale.status, 200);
    assertEquals(stale.body.harnessStale, true);
    assertEquals(stale.body.serve, [], "refuse policy withholds SERVE for a stale harness");
    assertEquals(stale.body.roles, []);
    // A healthy worker is routed exactly as today.
    const healthy = (await guarded(input({ capability: { cognition: "decide" }, instance: "w2", harnessProtocol: 5 }), app)) as any;
    assertEquals(healthy.body.harnessStale, false);
    assert(healthy.body.serve.includes("decide"), "healthy harness routed under refuse policy");
  } finally {
    if (prev === undefined) delete process.env["NANO_AGENTIC_STALE_HARNESS_POLICY"];
    else process.env["NANO_AGENTIC_STALE_HARNESS_POLICY"] = prev;
  }
});
