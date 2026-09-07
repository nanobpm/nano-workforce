// Testkit-boot read-back tests for the engine agent-history endpoints (issue #745/#747):
//   GET /agentic/agent-instances                          → listAgentInstances
//   GET /agentic/agent-instances/{agentInstanceKey}/history → getAgentInstanceHistory
//
// These drive the REAL door through `bootTestApp`'s api driver against the WASM EngineClient double.
// The testkit engine implements the agent read methods as READ-AS-ABSENCE (it records no AgentInstance
// channel), so a booted app returns an empty list / empty history rather than an error — exactly the
// contract the production consumer relies on when an engine has no durable agent history yet.
// Behavioural parity (non-empty history) is validated against a LIVE engine, out of the testkit's scope.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { AppApi } from "@nanobpm/urban";
import { assertEquals } from "#test-assert";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";
import type { AgentHistoryReader } from "../app/agentic/agent-history.ts";
import { noopLog } from "../test/log.ts";
import type { AgentHistory, AgentInstanceList } from "../nano-generated/api-io.d.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");

async function withApp(fn: (app: TestApp) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-agenthist-"));
  const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dir, "app.db")}` } });
  try {
    await fn(app);
  } finally {
    await app.stop?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("listAgentInstances: read-as-absence → 200 with an empty instance list", async () => {
  await withApp(async (app) => {
    const res = await app.api.call<AgentInstanceList>("listAgentInstances", {});
    assertEquals(res.status, 200);
    assertEquals(res.body.count, 0);
    assertEquals(res.body.instances.length, 0);
  });
});

test("getAgentInstanceHistory: an unknown key → 200 with an empty history (read-as-absence)", async () => {
  await withApp(async (app) => {
    const res = await app.api.call<AgentHistory>("getAgentInstanceHistory", {
      params: { agentInstanceKey: "no-such-instance" },
    });
    assertEquals(res.status, 200);
    assertEquals(res.body.agentInstanceKey, "no-such-instance");
    assertEquals(res.body.count, 0);
    assertEquals(res.body.records.length, 0);
  });
});

// Shared-secret guard regression coverage. Both endpoints implement the same optional guard the other
// agentic reads pin (x-hook-secret when NANO_PR_WEBHOOK_SECRET is set; unset -> open). `SECRET` is
// captured at module load, so set the env and re-import with a cache-buster to re-capture it, exactly
// as the sibling operation guard tests do. A lightweight stub engine (read-as-absence) is enough for
// the authorised path — the point is to pin 401-without-header / non-401-with-header, so a future
// refactor can't silently invert the condition or rename the header.
const stubEngine: AgentHistoryReader = {
  searchAgentInstances: async () => [],
  searchAgentInstanceHistory: async () => [],
  getAgentInstance: async () => null,
};
const guardApp = { log: noopLog(), engine: stubEngine } as unknown as AppApi;

function guardInput(headers: Record<string, string>, params: Record<string, string> = {}) {
  return {
    req: { method: "GET", headers: new Headers(headers), text: async () => "" } as never,
    params,
    query: {},
    body: undefined,
  };
}

test("listAgentInstances: shared-secret guard rejects a missing/invalid secret, admits the correct one", async () => {
  const prev = process.env["NANO_PR_WEBHOOK_SECRET"];
  process.env["NANO_PR_WEBHOOK_SECRET"] = "s3cr3t";
  try {
    const mod = await import(`./listAgentInstances.ts?guard=${Date.now()}`);
    const handler = mod.default as (i: ReturnType<typeof guardInput>, app: AppApi) => Promise<{ status: number }>;
    assertEquals((await handler(guardInput({}), guardApp)).status, 401);
    assertEquals((await handler(guardInput({ "x-hook-secret": "wrong" }), guardApp)).status, 401);
    assertEquals((await handler(guardInput({ "x-hook-secret": "s3cr3t" }), guardApp)).status, 200);
  } finally {
    if (prev === undefined) delete process.env["NANO_PR_WEBHOOK_SECRET"];
    else process.env["NANO_PR_WEBHOOK_SECRET"] = prev;
  }
});

test("getAgentInstanceHistory: shared-secret guard rejects a missing/invalid secret, admits the correct one", async () => {
  const prev = process.env["NANO_PR_WEBHOOK_SECRET"];
  process.env["NANO_PR_WEBHOOK_SECRET"] = "s3cr3t";
  try {
    const mod = await import(`./getAgentInstanceHistory.ts?guard=${Date.now()}`);
    const handler = mod.default as (i: ReturnType<typeof guardInput>, app: AppApi) => Promise<{ status: number }>;
    const params = { agentInstanceKey: "ai-1" };
    assertEquals((await handler(guardInput({}, params), guardApp)).status, 401);
    assertEquals((await handler(guardInput({ "x-hook-secret": "wrong" }, params), guardApp)).status, 401);
    assertEquals((await handler(guardInput({ "x-hook-secret": "s3cr3t" }, params), guardApp)).status, 200);
  } finally {
    if (prev === undefined) delete process.env["NANO_PR_WEBHOOK_SECRET"];
    else process.env["NANO_PR_WEBHOOK_SECRET"] = prev;
  }
});
