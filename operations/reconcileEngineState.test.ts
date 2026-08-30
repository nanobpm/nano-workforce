// Delegate-level tests for POST /app/api/reconcile → operation `reconcileEngineState` (issue #622).
// Covers the shared-secret guard (401), the no-data-source guard (503), and a happy-path 200 that
// exercises the wiring to `runEngineReconcile` against the REAL shipping schema (the whole migration
// set on an in-memory SQLite) with the engine `/topology` probe stubbed — so the operator command's
// auth guard, status codes, and reconcile wiring are regression-covered by the Node test suite.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";
import { freshData } from "../test/reconcileDb.ts";
import handler from "./reconcileEngineState.ts";

function input(headers: Record<string, string> = {}) {
  return {
    req: {
      method: "POST",
      path: "/app/api/reconcile",
      query: new URLSearchParams(),
      headers: new Headers(headers),
      text: async () => "",
    } as any,
    params: {},
    query: {},
    body: undefined,
  };
}

/** Stub the global `/topology` probe so the delegate never touches the network; restore after. */
async function withEngineEpoch<T>(epoch: number | null, fn: () => Promise<T>): Promise<T> {
  const prev = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      json: async () => (epoch == null ? {} : { nano: { incarnation: epoch } }),
    }) as unknown as Response) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prev;
  }
}

test("returns 503 when no data source is configured", async () => {
  const app = { log: noopLog() } as any as AppApi;
  const res = (await handler(input(), app)) as any;
  assertEquals(res.status, 503);
  assert("error" in res.body);
});

test("first observation seeds the epoch and returns 200 with a reconcile result", async () => {
  const { data } = freshData();
  const app = { data, log: noopLog() } as any as AppApi;
  const res = await withEngineEpoch(7, async () => (await handler(input(), app)) as any);
  assertEquals(res.status, 200);
  assertEquals(res.body.reason, "seed-epoch");
  assertEquals(res.body.orphanedCount, 0);
  assert(typeof res.body.runId === "string" && res.body.runId.length > 0);
});

test("shared-secret guard rejects a missing/wrong secret when configured", async () => {
  const prev = process.env["NANO_PR_WEBHOOK_SECRET"];
  process.env["NANO_PR_WEBHOOK_SECRET"] = "s3cr3t";
  try {
    // SECRET is bound at import time, so import a cache-busted copy to observe the guard.
    const mod = await import(`./reconcileEngineState.ts?guard=${Date.now()}`);
    const guarded = mod.default as typeof handler;
    const { data } = freshData();
    const app = { data, log: noopLog() } as any as AppApi;
    const bad = (await guarded(input(), app)) as any;
    assertEquals(bad.status, 401);
    const wrong = (await guarded(input({ "x-hook-secret": "nope" }), app)) as any;
    assertEquals(wrong.status, 401);
    const ok = await withEngineEpoch(7, async () =>
      (await guarded(input({ "x-hook-secret": "s3cr3t" }), app)) as any,
    );
    assertEquals(ok.status, 200);
  } finally {
    if (prev === undefined) delete process.env["NANO_PR_WEBHOOK_SECRET"];
    else process.env["NANO_PR_WEBHOOK_SECRET"] = prev;
  }
});
