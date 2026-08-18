// Tests for GET /app/api/agentic/registry → operation `getAgenticRegistry` (epic #152 / N1 #145).
//
// The report's computation is exercised exhaustively over injected demand/supply in
// `app/agentic/vocab/demand-report.test.ts`. Here we assert the operation returns a 200 with a
// well-formed report shape. The demand read degrades gracefully (no engine → supply-only), so the
// assertions tolerate `demandUnavailable` being either true or false — no live-engine dependency.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";
import handler from "./getAgenticRegistry.ts";

const app = { log: noopLog() } as unknown as AppApi;

function input(headers: Record<string, string> = {}) {
  return {
    req: { method: "GET", path: "/app/api/agentic/registry", query: new URLSearchParams(), headers: new Headers(headers), text: async () => "" } as any,
    params: {},
    query: {},
    body: undefined,
  };
}

test("returns 200 with a well-formed demand×supply report", async () => {
  const res = (await handler(input(), app)) as any;
  assertEquals(res.status, 200);
  assert(typeof res.body.version === "number");
  assert(["green", "amber", "red"].includes(res.body.status));
  assert(Array.isArray(res.body.networks));
  assert(Array.isArray(res.body.missing));
  assert(Array.isArray(res.body.nonAgentic));
  assert(typeof res.body.demandUnavailable === "boolean");
  assert(["green", "amber", "red"].includes(res.body.diversity.status));
});

test("shared-secret guard rejects a missing secret when configured", async () => {
  // The delegate captures the secret at import time, so re-import a cache-busted copy with the env
  // var set to exercise the guarded 401 path and the authorized 200 path.
  const prev = process.env["NANO_PR_WEBHOOK_SECRET"];
  process.env["NANO_PR_WEBHOOK_SECRET"] = "s3cr3t";
  try {
    const mod = await import(`./getAgenticRegistry.ts?guard=${Date.now()}`);
    const guarded = mod.default as typeof handler;
    const bad = (await guarded(input(), app)) as any;
    assertEquals(bad.status, 401);
    const ok = (await guarded(input({ "x-hook-secret": "s3cr3t" }), app)) as any;
    assertEquals(ok.status, 200);
    assert(typeof ok.body.version === "number");
  } finally {
    if (prev === undefined) delete process.env["NANO_PR_WEBHOOK_SECRET"];
    else process.env["NANO_PR_WEBHOOK_SECRET"] = prev;
  }
});
