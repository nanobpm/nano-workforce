// Tests for POST /app/api/agentic/enrol → operation `enrolAgenticWorker` (epic #152 / N1 #145).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
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
