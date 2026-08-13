// End-to-end WIRING test for the agentic visibility plane (ADR 0056) — the H6 (#149) closing slice.
//
// This is the deterministic integration test the epic asked for: it stands up a REAL AgenticHub over
// an in-memory transport, mounts the WHOLE family fleet through the H0 (#143) discovery SEAM
// (`loadAgenticFamilies` — so H1 presence, H3 relay, and H6 correlation all attach exactly as they do
// in production), and drives a worker + a cockpit consumer end to end:
//
//   H0  the seam discovers + mounts every `*.family.ts` and tears them down in reverse;
//   H1  a worker REGISTER creates a live presence row with its declared family + host;
//   H6  the orchestrator links the worker's jobKey → process instance / plan;
//   H5  GET /app/api/agentic/supply reports the worker with jobKeys populated, the drill stream
//       repointed at `job:<jobKey>`, and the job's correlation (process instance / plan);
//   H3  the worker relays terminal output on the jobKey-scoped stream and a cockpit TerminalSession
//       drills in and reads it — then, across a HUB RESTART (ring lost, db shared), the same session
//       resumes-from-offset: it re-attaches and receives only the un-applied tail, with no loss and
//       no duplication.
//
// It is timer-free and deterministic: connections are in-memory, `flush` yields to the next
// event-loop turn via `setImmediate` (so all pending microtasks settle before it resolves), and
// every assertion is on settled state. There are no retries and no sleeps.
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AgenticHub } from "@nanobpm/agentic/channel";
import type { Authenticator, ChannelConnection, ChannelTransport } from "@nanobpm/agentic/channel";
import { TerminalSession } from "@nanobpm/agentic/cockpit";
import type { SqliteDb } from "@nanobpm/agentic/presence";
import { decodeFrame, encodeFrame, type Frame } from "@nanobpm/agentic/protocol";
import type { AppApi, DataLayer } from "@nanobpm/urban";
import { assert, assertEquals } from "#test-assert";
import { currentCorrelation } from "../app/agentic/correlation.ts";
import { loadAgenticFamilies } from "../app/agentic/loader.ts";
import type { AgenticContext, AgenticFamily } from "../app/agentic/registry.ts";
import handler from "../operations/getAgenticSupply.ts";
import { noopLog } from "./log.ts";

// ── in-memory substrate ──────────────────────────────────────────────────────────────────────────

/** One shared in-memory SQLite db — the durable substrate that survives a hub restart. */
function memSqlite(): SqliteDb {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params = []) => {
      const r = db.prepare(sql).run(...(params as never[]));
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    all: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])) as T[],
  };
}

function memData(db: SqliteDb): DataLayer {
  return { source: () => ({ db }) } as unknown as DataLayer;
}

/** An in-memory transport whose `connect` hands the hub a fresh connection. */
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

/**
 * A live in-memory connection: `feed` delivers a frame TO the hub; `sent` collects frames FROM it.
 * `close()` fires the hub's registered close listener, so teardown/presence-cleanup paths run as in
 * production (rather than silently swallowing the disconnect).
 */
function conn(id: string, identity: string): { conn: ChannelConnection; feed(frame: Frame): void; sent: Frame[] } {
  let onMessage: ((bytes: Uint8Array) => void) | undefined;
  let onClose: ((code?: number, reason?: string) => void) | undefined;
  const sent: Frame[] = [];
  const channelConn: ChannelConnection = {
    id,
    handshake: { query: { identity }, token: "t", credential: "c" },
    send: (bytes) => sent.push(decodeFrame(bytes)),
    close: (code, reason) => onClose?.(code, reason),
    onMessage: (l) => {
      onMessage = l;
    },
    onClose: (l) => {
      onClose = l;
    },
  };
  return { conn: channelConn, feed: (frame) => onMessage?.(encodeFrame(frame)), sent };
}

const authenticator: Authenticator = (req) => ({ ok: true, grant: { identity: req.query?.identity ?? "anon" } });
const flush = () => new Promise((resolve) => setImmediate(resolve));

// ── relay wire helpers (the S5 sub-protocol, mirrored from relay.family.test.ts) ──────────────────

const RELAY_FAMILY = "relay";
const produce = (stream: string, incarnation: number, chunk: string): Frame => ({
  lane: "bulk",
  family: RELAY_FAMILY,
  seq: 0,
  payload: { op: "produce", stream, incarnation, chunk },
});

// ── the harness: a real hub with the whole family fleet mounted through the H0 seam ───────────────

interface MountedHub {
  hub: AgenticHub;
  transport: { transport: ChannelTransport; connect(c: ChannelConnection): void };
  families: AgenticFamily[];
  teardown(): Promise<void>;
}

async function mountFleet(db: SqliteDb): Promise<MountedHub> {
  const transport = memTransport();
  const hub = new AgenticHub({ transport: transport.transport, authenticator, sweepIntervalMs: 0 });
  // H0: discover + mount the WHOLE fleet exactly as production boot does.
  const families = await loadAgenticFamilies(undefined, noopLog());
  const ctx: AgenticContext = {
    hub,
    registry: hub.registry,
    transport: transport.transport as never,
    data: memData(db),
    log: noopLog(),
  };
  for (const family of families) await family.mount(ctx);
  return {
    hub,
    transport,
    families,
    teardown: async () => {
      for (const family of [...families].reverse()) await family.teardown?.();
      await hub.close();
    },
  };
}

const app = { log: noopLog() } as unknown as AppApi;
function supplyInput() {
  return { req: { method: "GET", path: "/app/api/agentic/supply", query: new URLSearchParams(), headers: new Headers(), text: async () => "" } as never, params: {}, query: {}, body: undefined };
}

test("E2E: the whole visibility plane wires up — presence, correlation, supply report, relay drill, and resume across a hub restart", async () => {
  const db = memSqlite();
  const JOB = "6494";
  const STREAM = `job:${JOB}`;

  // Sanity: the fleet the seam discovers really includes presence, relay, and correlation.
  const fleet = await mountFleet(db);
  const names = fleet.families.map((f) => f.name);
  assert(names.includes("presence"), "H1 presence family is discovered by the H0 seam");
  assert(names.includes("relay"), "H3 relay family is discovered by the H0 seam");
  assert(names.includes("correlation"), "H6 correlation family is discovered by the H0 seam");

  // ── H1: a worker connects and REGISTERs; a live presence row appears with its family/host. ──
  const worker = conn("wk-conn-1", "leafA");
  fleet.transport.connect(worker.conn);
  await flush();
  worker.feed({ lane: "control", family: "register", seq: 1, payload: { instance: "wk-a", capability: { family: "opus", host: "boxA" } } });
  await flush();

  // ── H6: the orchestrator links the worker's active jobKey to its process instance / plan. ──
  const correlation = currentCorrelation();
  assert(correlation !== undefined, "the correlation family installed the singleton");
  correlation.link("wk-a", JOB, { processInstanceKey: "4612", bpmnProcessId: "plan-fanout", elementId: "implement-task", planKey: "nanobpm/nano-workforce#142" });

  // ── H5: the supply report shows the worker with jobKeys, the repointed stream, and the correlation. ──
  {
    const res = (await handler(supplyInput(), app)) as {
      status: number;
      body: { count: number; workers: Array<Record<string, unknown>>; correlations: Array<Record<string, unknown>> };
    };
    assertEquals(res.status, 200);
    assertEquals(res.body.count, 1);
    const w = res.body.workers[0];
    assertEquals(w.instance, "wk-a");
    assertEquals(w.family, "opus");
    assertEquals(w.host, "boxA");
    assertEquals(w.jobKeys, [JOB], "H1×H6: the correlation registry feeds the presence jobKeys seam");
    assertEquals(w.stream, STREAM, "H6: the drill stream repoints at the live job's stream");
    assertEquals(res.body.correlations.length, 1);
    const c = res.body.correlations[0];
    assertEquals(c.jobKey, JOB);
    assertEquals(c.stream, STREAM);
    assertEquals(c.processInstanceKey, "4612");
    assertEquals(c.bpmnProcessId, "plan-fanout");
    assertEquals(c.planKey, "nanobpm/nano-workforce#142");
  }

  // ── H3: the worker relays 3 chunks; a cockpit TerminalSession drills in and reads them all. ──
  const written: string[] = [];
  const sink = { write: (chunk: string) => written.push(chunk) };

  // Wire a cockpit consumer connection through the hub. The TerminalSession speaks the S5 sub-protocol
  // (RelayOutbound/RelayInbound); we wrap outbound as control frames to the hub and unwrap the frames
  // the hub sends back to it into the session — exactly what RelayChannelClient does in the browser.
  let cockpit = conn("cockpit-conn-1", "leafOps");
  fleet.transport.connect(cockpit.conn);
  await flush();
  const session = new TerminalSession({
    stream: STREAM,
    sink,
    send: (message) => cockpit.feed({ lane: "control", family: RELAY_FAMILY, seq: 0, payload: message }),
    credit: 1024,
  });
  const drainToSession = async (c: { sent: Frame[] }) => {
    await flush();
    while (c.sent.length > 0) {
      const frame = c.sent.shift();
      if (frame) session.handle(frame.payload as never);
    }
    await flush();
  };

  worker.feed(produce(STREAM, 1, "c0"));
  worker.feed(produce(STREAM, 1, "c1"));
  worker.feed(produce(STREAM, 1, "c2"));
  await flush();
  session.attach();
  await drainToSession(cockpit);
  assertEquals(written, ["c0", "c1", "c2"], "the consumer receives every relayed chunk in order");
  assertEquals(session.nextOffset, 3, "the session's resume point advanced past the applied tail");

  // ── H3 resume-from-offset ACROSS A HUB RESTART: ring is lost, the shared db persists. ──
  await fleet.teardown();

  const fleet2 = await mountFleet(db);
  // Re-link the correlation on the fresh process (the resumed orchestrator re-establishes it).
  currentCorrelation()?.link("wk-a", JOB, { processInstanceKey: "4612", bpmnProcessId: "plan-fanout" });

  // The worker reconnects and replays its transcript (c0..c2) plus TWO NEW chunks (c3, c4) on a bumped
  // incarnation — a fresh ring, offsets restart at 0.
  const worker2 = conn("wk-conn-2", "leafA");
  fleet2.transport.connect(worker2.conn);
  await flush();
  worker2.feed({ lane: "control", family: "register", seq: 1, payload: { instance: "wk-a", capability: { family: "opus", host: "boxA" } } });
  for (let i = 0; i < 5; i++) worker2.feed(produce(STREAM, 2, `c${i}`));
  await flush();

  // The SAME cockpit session reconnects (new hub connection) and re-attaches. Because it resumes from
  // its own nextOffset (3), it receives ONLY the un-applied tail c3,c4 — no loss, no duplicate replay.
  cockpit = conn("cockpit-conn-2", "leafOps");
  fleet2.transport.connect(cockpit.conn);
  await flush();
  session.attach();
  await drainToSession(cockpit);

  assertEquals(written, ["c0", "c1", "c2", "c3", "c4"], "resume-from-offset delivers only the new tail — no loss, no duplication");

  // Belt-and-braces: every delivered data frame after resume was at offset ≥ 3 (nothing below the
  // resume point was re-applied).
  assert(session.nextOffset >= 5, "the resume point advanced through the replayed tail");

  await fleet2.teardown();
});
