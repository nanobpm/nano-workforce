// Tests for GET /app/api/agent/skill → operation `getAgentSkill` (ADR 0058 OpenAPI surface).
// The SKILL.md markdown is served as the `skill` field with any example keyed to the request's
// control-API base. Mirrors the getAgentInstructions test's request shape and shared-secret guard.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";
import handler from "./getAgentSkill.ts";

const app = { log: noopLog() } as any as AppApi;

function input(headers: Record<string, string> = {}, path = "/app/api/agent/skill") {
  return {
    req: {
      method: "GET",
      path,
      query: new URLSearchParams(),
      headers: new Headers(headers),
      text: async () => "",
    } as any,
    params: {},
    query: {},
    body: undefined,
  };
}

test("returns 200 with the SKILL.md markdown and metadata", async () => {
  const r = (await handler(input(), app)) as any;
  assertEquals(r.status, 200);
  assertEquals(r.body.format, "markdown");
  assert("appVersion" in r.body); // nullable, but always present
  assert(typeof r.body.generatedAt === "string" && r.body.generatedAt.length > 0);
  assert(typeof r.body.baseUrl === "string" && r.body.baseUrl.length > 0);
  assert(typeof r.body.skill === "string" && r.body.skill.length > 200);
});

test("the skill is the portable bootstrap: frontmatter + fetch-the-live-guide", async () => {
  const md = ((await handler(input(), app)) as any).body.skill as string;
  assert(md.includes("name: nano-workforce"), "carries the skill frontmatter");
  assert(md.includes("/agent"), "bootstraps by fetching the live operator guide");
  assert(md.includes("Confirm which instance") || md.includes("confirm"), "tells the agent to confirm the target instance");
});

test("baseUrl is keyed to the request's control-API base; no placeholder leaks", async () => {
  const forwarded = input({ host: "wf.example.com", "x-forwarded-proto": "https" });
  const body = (await handler(forwarded, app)) as any;
  assertEquals(body.body.baseUrl, "https://wf.example.com/app/api");
  assert(!body.body.skill.includes("__BASE__"), "no unsubstituted __BASE__ placeholder");
});

test("x-forwarded-proto is restricted to http/https", async () => {
  const spoofed = input({ host: "wf.example.com", "x-forwarded-proto": "javascript" });
  const body = (await handler(spoofed, app)) as any;
  assertEquals(body.body.baseUrl, "http://wf.example.com/app/api", "unsafe scheme falls back to http");
});

test("shared-secret guard rejects a missing/wrong secret when configured", async () => {
  const prev = process.env["NANO_PR_WEBHOOK_SECRET"];
  process.env["NANO_PR_WEBHOOK_SECRET"] = "s3cr3t";
  try {
    // SECRET is bound at import time, so import a cache-busted copy to observe the guard.
    const mod = await import(`./getAgentSkill.ts?guard=${Date.now()}`);
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
