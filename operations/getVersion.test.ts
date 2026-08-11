// Tests for GET /app/api/version → operation `getVersion` (ADR 0058 OpenAPI surface).
// Ported from the previous actions/version.test.ts. Method handling now belongs to the router
// (only GET is routed here), so there is no 405 case to test at the delegate level.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";
import handler from "./getVersion.ts";

const app = { log: noopLog() } as any as AppApi;

function input(headers: Record<string, string> = {}) {
  return {
    req: {
      method: "GET",
      path: "/app/api/version",
      query: new URLSearchParams(),
      headers: new Headers(headers),
      text: async () => "",
    } as any,
    params: {},
    query: {},
    body: undefined,
  };
}

test("returns 200 with the app identity", async () => {
  const res = await handler(input(), app);
  const r = res as any;
  assertEquals(r.status, 200);
  assertEquals(r.body.name, "nano-workforce");
  // These are always present; their values are environment-dependent so we only assert shape.
  assert("version" in r.body);
  assert("urbanVersion" in r.body);
  assert("gitSha" in r.body);
  assert("gitBranch" in r.body);
  assert(typeof r.body.runtime === "string" && r.body.runtime.length > 0);
  assert(typeof r.body.startedAt === "string");
  assert(typeof r.body.uptimeSeconds === "number");
});

test("shared-secret guard rejects a missing/wrong secret when configured", async () => {
  const prev = process.env["NANO_PR_WEBHOOK_SECRET"];
  process.env["NANO_PR_WEBHOOK_SECRET"] = "s3cr3t";
  try {
    // SECRET is bound at import time, so import a cache-busted copy to observe the guard.
    const mod = await import(`./getVersion.ts?guard=${Date.now()}`);
    const guarded = mod.default as typeof handler;
    const bad = (await guarded(input(), app)) as any;
    assertEquals(bad.status, 401);
    const ok = (await guarded(input({ "x-hook-secret": "s3cr3t" }), app)) as any;
    assertEquals(ok.status, 200);
  } finally {
    if (prev === undefined) delete process.env["NANO_PR_WEBHOOK_SECRET"];
    else process.env["NANO_PR_WEBHOOK_SECRET"] = prev;
  }
});
