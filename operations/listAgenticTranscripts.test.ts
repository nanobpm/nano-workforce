// Tests for GET /app/api/agentic/transcripts → operation `listAgenticTranscripts` (H3 read path, #222).
//
// Covers: the empty list when no relay/transcript family is mounted; the shared-secret guard; the
// end-to-end projection of a mounted TranscriptStore's rows into the list (byteLength, chunkCount,
// lifecycle/status, jobKey decoded from the stream id); correlation enrichment (process instance /
// plan) when the H6 correlation family is mounted; and the jobKey / plan / time filters.
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { ConnectionRegistry } from "@nanobpm/agentic/channel";
import type { Frame } from "@nanobpm/agentic/protocol";
import type { SqliteDb } from "@nanobpm/agentic/transcript";
import type { AppApi, DataLayer } from "@nanobpm/urban";
import { assert, assertEquals } from "#test-assert";
import { currentCorrelation } from "../app/agentic/correlation.ts";
import { family as correlationFamily } from "../app/agentic/families/correlation.family.ts";
import { createRelayFamily, currentRelayTranscriptService } from "../app/agentic/families/relay.family.ts";
import type { AgenticContext } from "../app/agentic/registry.ts";
import { noopLog } from "../test/log.ts";
import handler from "./listAgenticTranscripts.ts";

function memSqlite(): SqliteDb {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params = []) => {
      const r = db.prepare(sql).run(...(params as never[]));
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    all: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...(params as never[])) as T[],
  };
}

function memData(db: SqliteDb): DataLayer {
  return { source: () => ({ db }) } as unknown as DataLayer;
}

/** A hub double that just captures the relay family handler (unused here — we seed the store directly). */
function fakeHub() {
  return {
    registerFamilyHandler(_family: string, _handler: (frame: Frame, conn: never) => void) {},
    registry: { has: () => false, list: () => [] },
  };
}

function mountCtx(db: SqliteDb): AgenticContext {
  const hub = fakeHub();
  return {
    hub: hub as never,
    registry: hub.registry as unknown as ConnectionRegistry,
    transport: undefined as never,
    data: memData(db),
    log: noopLog(),
  };
}

function input(query: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return {
    req: { method: "GET", path: "/app/api/agentic/transcripts", query: new URLSearchParams(), headers: new Headers(headers), text: async () => "" } as never,
    params: {},
    query,
    body: undefined,
  };
}

const app = { log: noopLog() } as unknown as AppApi;
const relayFamily = createRelayFamily();

test("returns an empty list when no relay/transcript family is mounted", async () => {
  relayFamily.teardown?.();
  const res = (await handler(input(), app)) as { status: number; body: { count: number; transcripts: unknown[] } };
  assertEquals(res.status, 200);
  assertEquals(res.body.count, 0);
  assertEquals(res.body.transcripts.length, 0);
});

test("projects the TranscriptStore rows into the list (byteLength, chunkCount, lifecycle, jobKey)", async () => {
  relayFamily.mount(mountCtx(memSqlite()));
  const store = currentRelayTranscriptService()?.store;
  assert(store !== undefined, "the relay family installs a persisted store");
  // Seed one completed ephemeral session on a jobKey-scoped stream.
  store.flush("job:6494", { since: () => ({ entries: [{ offset: 0, chunk: "hello " }, { offset: 1, chunk: "world" }] }), nextOffset: 2 }, "ephemeral");
  try {
    const res = (await handler(input(), app)) as {
      status: number;
      body: { count: number; retentionMs?: number; transcripts: Array<Record<string, unknown>> };
    };
    assertEquals(res.status, 200);
    assertEquals(res.body.count, 1);
    assert(typeof res.body.retentionMs === "number", "the list surfaces the retention window");
    const t = res.body.transcripts[0];
    assertEquals(t.stream, "job:6494");
    assertEquals(t.jobKey, "6494", "the jobKey is decoded from the job: stream id");
    assertEquals(t.lifecycle, "ephemeral");
    assertEquals(t.status, "completed");
    assertEquals(t.chunkCount, 2);
    assertEquals(t.byteLength, "hello world".length);
    assertEquals(t.nextOffset, 2);
  } finally {
    relayFamily.teardown?.();
  }
});

test("enriches with the H6 correlation (process instance / plan) when it is still live", async () => {
  relayFamily.mount(mountCtx(memSqlite()));
  const store = currentRelayTranscriptService()?.store;
  assert(store !== undefined);
  store.flush("job:6494", { since: () => ({ entries: [{ offset: 0, chunk: "x" }] }), nextOffset: 1 }, "ephemeral");
  correlationFamily.mount({ hub: undefined as never, registry: undefined as never, transport: undefined as never, data: undefined, log: noopLog() });
  currentCorrelation()?.link("wk-a", "6494", { processInstanceKey: "4612", bpmnProcessId: "plan-fanout", planKey: "o/r#142" });
  try {
    const res = (await handler(input(), app)) as { body: { transcripts: Array<Record<string, unknown>> } };
    const t = res.body.transcripts[0];
    assertEquals(t.processInstanceKey, "4612");
    assertEquals(t.bpmnProcessId, "plan-fanout");
    assertEquals(t.planKey, "o/r#142");
  } finally {
    correlationFamily.teardown?.();
    relayFamily.teardown?.();
  }
});

test("filters by jobKey and plan", async () => {
  relayFamily.mount(mountCtx(memSqlite()));
  const store = currentRelayTranscriptService()?.store;
  assert(store !== undefined);
  store.flush("job:1", { since: () => ({ entries: [{ offset: 0, chunk: "a" }] }), nextOffset: 1 }, "ephemeral");
  store.flush("job:2", { since: () => ({ entries: [{ offset: 0, chunk: "b" }] }), nextOffset: 1 }, "ephemeral");
  correlationFamily.mount({ hub: undefined as never, registry: undefined as never, transport: undefined as never, data: undefined, log: noopLog() });
  currentCorrelation()?.link("wk", "2", { planKey: "o/r#9" });
  try {
    const byJob = (await handler(input({ jobKey: "1" }), app)) as { body: { count: number; transcripts: Array<Record<string, unknown>> } };
    assertEquals(byJob.body.count, 1);
    assertEquals(byJob.body.transcripts[0]?.stream, "job:1");

    const byPlan = (await handler(input({ planKey: "o/r#9" }), app)) as { body: { count: number; transcripts: Array<Record<string, unknown>> } };
    assertEquals(byPlan.body.count, 1);
    assertEquals(byPlan.body.transcripts[0]?.stream, "job:2");
  } finally {
    correlationFamily.teardown?.();
    relayFamily.teardown?.();
  }
});

test("rejects a malformed since/until with a 400", async () => {
  relayFamily.mount(mountCtx(memSqlite()));
  try {
    const res = (await handler(input({ since: "not-a-date" }), app)) as { status: number };
    assertEquals(res.status, 400);
  } finally {
    relayFamily.teardown?.();
  }
});

test("shared-secret guard rejects a missing secret when configured", async () => {
  const prev = process.env["NANO_PR_WEBHOOK_SECRET"];
  process.env["NANO_PR_WEBHOOK_SECRET"] = "s3cr3t";
  try {
    const mod = await import(`./listAgenticTranscripts.ts?guard=${Date.now()}`);
    const guarded = mod.default as typeof handler;
    const bad = (await guarded(input(), app)) as { status: number };
    assertEquals(bad.status, 401);
    const ok = (await guarded(input({}, { "x-hook-secret": "s3cr3t" }), app)) as { status: number };
    assertEquals(ok.status, 200);
  } finally {
    if (prev === undefined) delete process.env["NANO_PR_WEBHOOK_SECRET"];
    else process.env["NANO_PR_WEBHOOK_SECRET"] = prev;
  }
});
