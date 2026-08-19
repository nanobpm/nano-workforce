// Tests for POST /app/api/agentic/enrol → operation `enrolAgenticWorker` (epic #152 / N1 #145).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { memDataFor } from "../test/worldDb.ts";
import { DurableResumeRegistry } from "../app/durableResume.ts";
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
