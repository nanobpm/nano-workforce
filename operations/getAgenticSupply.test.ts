// Tests for GET /app/api/agentic/supply → operation `getAgenticSupply` (H5 / #148).
//
// Covers: the empty report when no presence family is mounted; the shared-secret guard; and the
// end-to-end mapping of a mounted presence registry's snapshot into the supply report (stream keyed
// by instance, family/host/jobKeys/liveness) — driven through a REAL AgenticHub + in-memory transport
// exactly as the presence family is exercised, so the singleton the operation reads is the live one.
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AgenticHub } from "@nanobpm/agentic/channel";
import type { Authenticator, ChannelConnection, ChannelTransport } from "@nanobpm/agentic/channel";
import { encodeFrame, type Frame } from "@nanobpm/agentic/protocol";
import type { SqliteDb } from "@nanobpm/agentic/presence";
import type { AppApi, DataLayer } from "@nanobpm/urban";
import { assert, assertEquals } from "#test-assert";
import { currentClaimRegistry } from "../app/agentic/claim-registry.ts";
import { currentCorrelation } from "../app/agentic/correlation.ts";
import { family as claimFamily } from "../app/agentic/families/claim.family.ts";
import { family as correlationFamily } from "../app/agentic/families/correlation.family.ts";
import { family } from "../app/agentic/families/presence.family.ts";
import type { AgenticContext } from "../app/agentic/registry.ts";
import { noopLog } from "../test/log.ts";
import handler from "./getAgenticSupply.ts";

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

function memTransport(): { transport: ChannelTransport; connect(conn: ChannelConnection): void } {
  let onConnection: ((conn: ChannelConnection) => void) | undefined;
  const transport: ChannelTransport = {
    onConnection: (l) => {
      onConnection = l;
    },
    address: { port: 0 },
    close: async () => {},
  };
  return { transport, connect: (conn) => onConnection?.(conn) };
}

function fakeConn(id: string, identity: string): { conn: ChannelConnection; feed(frame: Frame): void } {
  let onMessage: ((bytes: Uint8Array) => void) | undefined;
  const conn: ChannelConnection = {
    id,
    handshake: { query: { identity }, token: "t", credential: "c" },
    send: () => {},
    close: () => {},
    onMessage: (l) => {
      onMessage = l;
    },
    onClose: () => {},
  };
  return { conn, feed: (frame) => onMessage?.(encodeFrame(frame)) };
}

const authenticator: Authenticator = (req) => ({ ok: true, grant: { identity: req.query?.identity ?? "anon" } });
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function mountPresence(db: SqliteDb): Promise<AgenticHub> {
  const transport = memTransport();
  const hub = new AgenticHub({ transport: transport.transport, authenticator, sweepIntervalMs: 0 });
  const ctx: AgenticContext = {
    hub,
    registry: hub.registry,
    transport: transport.transport as never,
    data: memData(db),
    log: noopLog(),
  };
  await family.mount(ctx);
  // Register one live worker under leaf "leafA" with declared family + host.
  const peer = fakeConn("c1", "leafA");
  transport.connect(peer.conn);
  await flush();
  peer.feed({ lane: "control", family: "register", seq: 1, payload: { instance: "wk-a", capability: { family: "opus", host: "boxA" } } });
  await flush();
  return hub;
}

function input(headers: Record<string, string> = {}) {
  return {
    req: {
      method: "GET",
      path: "/app/api/agentic/supply",
      query: new URLSearchParams(),
      headers: new Headers(headers),
      text: async () => "",
    } as never,
    params: {},
    query: {},
    body: undefined,
  };
}

const app = { log: noopLog() } as unknown as AppApi;

test("returns an empty supply report when no presence family is mounted", async () => {
  family.teardown?.();
  const res = (await handler(input(), app)) as { status: number; body: { count: number; workers: unknown[]; leaves: unknown[] } };
  assertEquals(res.status, 200);
  assertEquals(res.body.count, 0);
  assertEquals(res.body.workers.length, 0);
  assertEquals(res.body.leaves.length, 0);
});

test("maps the presence snapshot into the supply report (stream, family, host, liveness)", async () => {
  const hub = await mountPresence(memSqlite());
  try {
    const res = (await handler(input(), app)) as {
      status: number;
      body: { count: number; workers: Array<Record<string, unknown>>; leaves: Array<{ token: string; workers: unknown[] }> };
    };
    assertEquals(res.status, 200);
    assertEquals(res.body.count, 1);
    const w = res.body.workers[0];
    assertEquals(w.instance, "wk-a");
    assertEquals(w.identity, "leafA");
    assertEquals(w.stream, "wk-a", "the drill stream is keyed by the worker instance");
    assertEquals(w.family, "opus");
    assertEquals(w.host, "boxA");
    assertEquals(w.live, true);
    assertEquals(w.jobKeys, []);
    assertEquals(res.body.leaves[0]?.token, "leafA");
    assertEquals(res.body.leaves[0]?.workers.length, 1);
  } finally {
    family.teardown?.();
    await hub.close();
  }
});

test("shared-secret guard rejects a missing secret when configured", async () => {
  const prev = process.env["NANO_PR_WEBHOOK_SECRET"];
  process.env["NANO_PR_WEBHOOK_SECRET"] = "s3cr3t";
  try {
    const mod = await import(`./getAgenticSupply.ts?guard=${Date.now()}`);
    const guarded = mod.default as typeof handler;
    const bad = (await guarded(input(), app)) as { status: number };
    assertEquals(bad.status, 401);
    const ok = (await guarded(input({ "x-hook-secret": "s3cr3t" }), app)) as { status: number; body: Record<string, unknown> };
    assertEquals(ok.status, 200);
    assert("count" in ok.body);
  } finally {
    if (prev === undefined) delete process.env["NANO_PR_WEBHOOK_SECRET"];
    else process.env["NANO_PR_WEBHOOK_SECRET"] = prev;
  }
});

test("#713: a claim populates jobKeys and repoints the drill stream with ZERO transcript (claim is the visibility source)", async () => {
  const hub = await mountPresence(memSqlite());
  const ctx: AgenticContext = { hub, registry: hub.registry, transport: undefined as never, data: undefined, log: noopLog() };
  claimFamily.mount(ctx);
  const claims = currentClaimRegistry();
  assert(claims !== undefined, "the claim family installs the singleton");
  // An explicit claim — no relay produce frame, no correlation link, zero transcript.
  claims.claim("wk-a", "8420");
  try {
    const res = (await handler(input(), app)) as {
      status: number;
      body: { workers: Array<Record<string, unknown>>; correlations: unknown[] };
    };
    assertEquals(res.status, 200);
    const w = res.body.workers[0];
    assertEquals(w.jobKeys, ["8420"], "the claim registry feeds the jobKeys seam");
    assertEquals(w.stream, "job:8420", "the drill stream repoints at the claimed job, keyed by the claim");
    assertEquals(res.body.correlations.length, 0, "no correlation context until a terminal lands (drill-in only)");
  } finally {
    claimFamily.teardown?.();
    family.teardown?.();
    await hub.close();
  }
});

test("#713: the correlation registry is demoted to drill-in context — a link alone no longer feeds jobKeys", async () => {
  const hub = await mountPresence(memSqlite());
  correlationFamily.mount({
    hub,
    registry: hub.registry,
    transport: undefined as never,
    data: undefined,
    log: noopLog(),
  });
  const correlation = currentCorrelation();
  assert(correlation !== undefined, "the correlation family installs the singleton");
  // A correlation link (drill-in context) WITHOUT a claim: visibility must NOT light up from it.
  correlation.link("wk-a", "6494", { processInstanceKey: "4612", bpmnProcessId: "plan-fanout", elementId: "implement-task", planKey: "o/r#142" });
  try {
    const res = (await handler(input(), app)) as {
      status: number;
      body: {
        workers: Array<Record<string, unknown>>;
        correlations: Array<Record<string, unknown>>;
      };
    };
    assertEquals(res.status, 200);
    const w = res.body.workers[0];
    assertEquals(w.jobKeys, [], "correlation alone no longer feeds jobKeys (relay demoted)");
    assertEquals(w.stream, "wk-a", "the drill stream stays instance-keyed without a claim");
    // The correlation context is still reported for drill-in.
    assertEquals(res.body.correlations.length, 1);
    const c = res.body.correlations[0];
    assertEquals(c.jobKey, "6494");
    assertEquals(c.stream, "job:6494");
    assertEquals(c.processInstanceKey, "4612");
    assertEquals(c.bpmnProcessId, "plan-fanout");
    assertEquals(c.planKey, "o/r#142");
  } finally {
    correlationFamily.teardown?.();
    family.teardown?.();
    await hub.close();
  }
});
