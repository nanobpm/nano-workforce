// Tests for GET /app/api/agent → operation `getAgentInstructions` (ADR 0058 OpenAPI surface).
// The guide markdown is served as the `instructions` field with its examples keyed to the request's
// control-API base + the configured engine base. Mirrors the getVersion test's request shape and
// shared-secret guard pattern.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import handler from "./getAgentInstructions.ts";

const app = {} as any as AppApi;

function input(headers: Record<string, string> = {}, path = "/app/api/agent") {
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

test("returns 200 with the markdown guide and metadata", async () => {
  const r = (await handler(input(), app)) as any;
  assertEquals(r.status, 200);
  assertEquals(r.body.format, "markdown");
  assert("appVersion" in r.body); // nullable, but always present
  assert(typeof r.body.generatedAt === "string" && r.body.generatedAt.length > 0);
  assert(typeof r.body.baseUrl === "string" && r.body.baseUrl.length > 0);
  assert(typeof r.body.engineBase === "string" && r.body.engineBase.length > 0);
  assert(typeof r.body.instructions === "string" && r.body.instructions.length > 200);
});

test("the guide covers every capability the endpoint promises", async () => {
  const md = ((await handler(input(), app)) as any).body.instructions as string;
  // Submit a PR (converge vs. merge), submit an epic, answer escalations…
  assert(md.includes("start/convergence-loop"), "covers submitting a PR for convergence");
  assert(md.includes("convergeOnly"), "documents review-only vs. merge");
  assert(md.includes("start/plan-fanout"), "covers submitting an epic");
  assert(md.includes("escalation-answered"), "covers answering escalations");
  // …debug the system.
  assert(md.includes("/jobs/search") && md.includes("/incidents/search"), "covers engine REST debugging");
  assert(md.includes("processKey") || md.includes("process_key"), "relates instances to PRs");
  assert(md.includes("resources/processes") && md.includes("prompts/"), "covers debugging models + prompts");
  assert(md.includes("nanobpm/nano-workforce"), "covers raising issues/PRs against the repo");
});

test("examples are keyed to the request's control-API base and leave no placeholders", async () => {
  const forwarded = input({ host: "wf.example.com", "x-forwarded-proto": "https" });
  const md = ((await handler(forwarded, app)) as any).body.instructions as string;
  const body = (await handler(forwarded, app)) as any;
  assertEquals(body.body.baseUrl, "https://wf.example.com/app/api");
  assert(md.includes("https://wf.example.com/app/api/version"), "base URL substituted into examples");
  assert(!md.includes("__BASE__"), "no unsubstituted __BASE__ placeholder");
  assert(!md.includes("__ENGINE__"), "no unsubstituted __ENGINE__ placeholder");
});

test("engine base follows CAMUNDA_REST_ADDRESS / NANOBPMN_BASE_URL", async () => {
  const prevCamunda = process.env["CAMUNDA_REST_ADDRESS"];
  const prevBase = process.env["NANOBPMN_BASE_URL"];
  try {
    delete process.env["CAMUNDA_REST_ADDRESS"];
    process.env["NANOBPMN_BASE_URL"] = "http://engine.internal:8080";
    const r = (await handler(input(), app)) as any;
    assertEquals(r.body.engineBase, "http://engine.internal:8080/v2");
    assert(r.body.instructions.includes("http://engine.internal:8080/v2/jobs/search"));
  } finally {
    if (prevCamunda === undefined) delete process.env["CAMUNDA_REST_ADDRESS"];
    else process.env["CAMUNDA_REST_ADDRESS"] = prevCamunda;
    if (prevBase === undefined) delete process.env["NANOBPMN_BASE_URL"];
    else process.env["NANOBPMN_BASE_URL"] = prevBase;
  }
});

test("shared-secret guard rejects a missing/wrong secret when configured", async () => {
  const prev = process.env["NANO_PR_WEBHOOK_SECRET"];
  process.env["NANO_PR_WEBHOOK_SECRET"] = "s3cr3t";
  try {
    // SECRET is bound at import time, so import a cache-busted copy to observe the guard.
    const mod = await import(`./getAgentInstructions.ts?guard=${Date.now()}`);
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
