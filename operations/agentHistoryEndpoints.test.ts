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
import { assertEquals } from "#test-assert";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";
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
