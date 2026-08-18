// Tests for GET /app/api/agentic/vocab → operation `getAgenticVocab` (epic #152 / N1 #145).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";
import handler from "./getAgenticVocab.ts";

const app = { log: noopLog() } as unknown as AppApi;

function input(headers: Record<string, string> = {}) {
  return {
    req: { method: "GET", path: "/app/api/agentic/vocab", query: new URLSearchParams(), headers: new Headers(headers), text: async () => "" } as any,
    params: {},
    query: {},
    body: undefined,
  };
}

test("returns 200 with the published crew vocab view", async () => {
  const res = (await handler(input(), app)) as any;
  assertEquals(res.status, 200);
  assert(typeof res.body.version === "number");
  assert("planning" in res.body.networks, "networks tree is published");
  const spar = res.body.requirements.find((r: any) => r.token === "planning.spar");
  assert(spar !== undefined);
  assertEquals(spar.seatsDistinctFamily, true);
  assertEquals(spar.seats, ["red", "blue"]);
  assert(spar.requires.includes("cognition=planning"));
});

test("shared-secret guard rejects a missing secret when configured", async () => {
  // The delegate captures the secret at import time, so re-import a cache-busted copy with the env
  // var set to exercise the guarded 401 path and the authorized 200 path.
  const prev = process.env["NANO_PR_WEBHOOK_SECRET"];
  process.env["NANO_PR_WEBHOOK_SECRET"] = "s3cr3t";
  try {
    const mod = await import(`./getAgenticVocab.ts?guard=${Date.now()}`);
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
