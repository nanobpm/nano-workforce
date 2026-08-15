// Tests for GET /app/api/agentic/transcripts/{stream} → operation `getAgenticTranscript` (H3, #222).
//
// Covers: 404 when no store / unknown stream; the range/offset fetch (from=0 whole transcript, from>0
// resume-from-offset with the mirrored gap flag); the shared-secret guard; and correlation enrichment.
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { ConnectionRegistry } from "@nanobpm/agentic/channel";
import type { Frame } from "@nanobpm/agentic/protocol";
import type { SqliteDb } from "@nanobpm/agentic/transcript";
import type { AppApi, DataLayer } from "@nanobpm/urban";
import { assert, assertEquals } from "#test-assert";
import { createRelayFamily, currentRelayTranscriptService } from "../app/agentic/families/relay.family.ts";
import type { AgenticContext } from "../app/agentic/registry.ts";
import { noopLog } from "../test/log.ts";
import handler from "./getAgenticTranscript.ts";

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

function input(stream: string, query: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return {
    req: { method: "GET", path: `/app/api/agentic/transcripts/${stream}`, query: new URLSearchParams(), headers: new Headers(headers), text: async () => "" } as never,
    params: { stream },
    query,
    body: undefined,
  };
}

const app = { log: noopLog() } as unknown as AppApi;
const relayFamily = createRelayFamily();

test("404 when no store is mounted", async () => {
  relayFamily.teardown?.();
  const res = (await handler(input("job:1"), app)) as { status: number };
  assertEquals(res.status, 404);
});

test("404 for an unknown stream", async () => {
  relayFamily.mount(mountCtx(memSqlite()));
  try {
    const res = (await handler(input("job:nope"), app)) as { status: number };
    assertEquals(res.status, 404);
  } finally {
    relayFamily.teardown?.();
  }
});

test("returns the whole transcript from offset 0, then a resume slice from a later offset", async () => {
  relayFamily.mount(mountCtx(memSqlite()));
  const store = currentRelayTranscriptService()?.store;
  assert(store !== undefined);
  store.flush(
    "job:6494",
    { since: () => ({ entries: [{ offset: 0, chunk: "aa" }, { offset: 1, chunk: "bb" }, { offset: 2, chunk: "cc" }] }), nextOffset: 3 },
    "ephemeral",
  );
  try {
    const whole = (await handler(input("job:6494"), app)) as {
      status: number;
      body: { stream: string; from: number; gap: boolean; nextOffset: number; chunkCount: number; byteLength: number; entries: Array<{ offset: number; chunk: string }>; jobKey?: string };
    };
    assertEquals(whole.status, 200);
    assertEquals(whole.body.stream, "job:6494");
    assertEquals(whole.body.jobKey, "6494");
    assertEquals(whole.body.from, 0);
    assertEquals(whole.body.gap, false);
    assertEquals(whole.body.nextOffset, 3);
    assertEquals(whole.body.chunkCount, 3);
    assertEquals(whole.body.byteLength, 6);
    assertEquals(whole.body.entries.map((e) => e.offset), [0, 1, 2]);

    const resume = (await handler(input("job:6494", { from: 2 }), app)) as {
      body: { from: number; chunkCount: number; entries: Array<{ offset: number; chunk: string }> };
    };
    assertEquals(resume.body.from, 2);
    assertEquals(resume.body.chunkCount, 1);
    assertEquals(resume.body.entries.map((e) => e.chunk), ["cc"]);
  } finally {
    relayFamily.teardown?.();
  }
});

test("rejects a malformed from offset with a 400", async () => {
  relayFamily.mount(mountCtx(memSqlite()));
  try {
    const res = (await handler(input("job:1", { from: -1 }), app)) as { status: number };
    assertEquals(res.status, 400);
  } finally {
    relayFamily.teardown?.();
  }
});

test("shared-secret guard rejects a missing secret when configured", async () => {
  const prev = process.env["NANO_PR_WEBHOOK_SECRET"];
  process.env["NANO_PR_WEBHOOK_SECRET"] = "s3cr3t";
  try {
    const mod = await import(`./getAgenticTranscript.ts?guard=${Date.now()}`);
    const guarded = mod.default as typeof handler;
    const bad = (await guarded(input("job:1"), app)) as { status: number };
    assertEquals(bad.status, 401);
  } finally {
    if (prev === undefined) delete process.env["NANO_PR_WEBHOOK_SECRET"];
    else process.env["NANO_PR_WEBHOOK_SECRET"] = prev;
  }
});

test("shared-secret guard admits a correct secret when configured", async () => {
  const prev = process.env["NANO_PR_WEBHOOK_SECRET"];
  process.env["NANO_PR_WEBHOOK_SECRET"] = "s3cr3t";
  relayFamily.mount(mountCtx(memSqlite()));
  const store = currentRelayTranscriptService()?.store;
  assert(store !== undefined);
  store.flush(
    "job:6494",
    { since: () => ({ entries: [{ offset: 0, chunk: "aa" }] }), nextOffset: 1 },
    "ephemeral",
  );
  try {
    const mod = await import(`./getAgenticTranscript.ts?guard=${Date.now()}`);
    const guarded = mod.default as typeof handler;
    const ok = (await guarded(input("job:6494", {}, { "x-hook-secret": "s3cr3t" }), app)) as {
      status: number;
      body: { stream: string; chunkCount: number };
    };
    assertEquals(ok.status, 200);
    assertEquals(ok.body.stream, "job:6494");
    assertEquals(ok.body.chunkCount, 1);
  } finally {
    relayFamily.teardown?.();
    if (prev === undefined) delete process.env["NANO_PR_WEBHOOK_SECRET"];
    else process.env["NANO_PR_WEBHOOK_SECRET"] = prev;
  }
});
