// Tests for GET /app/version (version/identity endpoint).
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { AppApi } from "@nanobpm/urban";
import handler from "./version.ts";
import { buildVersionInfo } from "../app/version.ts";

// deno-lint-ignore no-explicit-any
const app = {} as any as AppApi;

function req(method: string, headers: Record<string, string> = {}) {
  return {
    method,
    path: "/app/version",
    query: new URLSearchParams(),
    headers: new Headers(headers),
    text: async () => "",
  };
}

async function call(method: string, headers: Record<string, string> = {}) {
  // deno-lint-ignore no-explicit-any
  const res = await handler({ req: req(method, headers) as any, body: undefined }, app);
  // deno-lint-ignore no-explicit-any
  return res as any;
}

Deno.test("GET returns 200 with the app identity", async () => {
  const res = await call("GET");
  assertEquals(res.status, 200);
  assertEquals(res.body.name, "nano-workforce");
  // These are always present; their values are environment-dependent so we only assert shape.
  assert("version" in res.body);
  assert("urbanVersion" in res.body);
  assert("gitSha" in res.body);
  assert("gitBranch" in res.body);
  assert(typeof res.body.runtime === "string" && res.body.runtime.length > 0);
  assert(typeof res.body.startedAt === "string");
  assert(typeof res.body.uptimeSeconds === "number");
});

Deno.test("non-GET is rejected with 405", async () => {
  const res = await call("POST");
  assertEquals(res.status, 405);
});

Deno.test("shared-secret guard rejects a missing/wrong secret when configured", async () => {
  const prev = Deno.env.get("NANO_PR_WEBHOOK_SECRET");
  Deno.env.set("NANO_PR_WEBHOOK_SECRET", "s3cr3t");
  try {
    // The handler binds SECRET at import time, so a freshly-imported module is needed to observe
    // the guard. Import a cache-busted copy so this test is independent of import order.
    const mod = await import(`./version.ts?guard=${Date.now()}`);
    const guarded = mod.default as typeof handler;
    // deno-lint-ignore no-explicit-any
    const bad = (await guarded({ req: req("GET") as any, body: undefined }, app)) as any;
    assertEquals(bad.status, 401);
    // deno-lint-ignore no-explicit-any
    const ok = (await guarded(
      // deno-lint-ignore no-explicit-any
      { req: req("GET", { "x-hook-secret": "s3cr3t" }) as any, body: undefined },
      app,
    )) as any;
    assertEquals(ok.status, 200);
  } finally {
    if (prev === undefined) Deno.env.delete("NANO_PR_WEBHOOK_SECRET");
    else Deno.env.set("NANO_PR_WEBHOOK_SECRET", prev);
  }
});

Deno.test("buildVersionInfo is side-effect free and stable in shape", () => {
  const a = buildVersionInfo();
  const b = buildVersionInfo();
  assertEquals(a.name, b.name);
  assertEquals(Object.keys(a).sort(), [
    "gitBranch",
    "gitSha",
    "name",
    "pid",
    "runtime",
    "startedAt",
    "uptimeSeconds",
    "urbanVersion",
    "version",
  ]);
});
