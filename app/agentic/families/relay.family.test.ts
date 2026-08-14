// Unit tests for the H3 relay ring + transcript store family (ADR 0056, #146).
//
// Exercises the acceptance surface of the mounted family through {@link RelayTranscriptService}:
//   - ring resume: a late/reconnecting consumer replays from an offset with no loss or duplication;
//   - lane priority: a bulk-output storm never head-of-line-blocks a control-lane frame;
//   - retention-by-lifecycle: an ephemeral stream's transcript is persisted on completion (and swept
//     after retention); a long-lived stream is checkpointed and stays reattachable, never auto-completed;
//   - disconnect-driven completion: an ephemeral stream flushes when its producer connection drops.
// Plus a drift guard proving `db/migrations/024_agentic_transcript.sql` mirrors the package's canonical
// transcript DDL byte-for-byte.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ConnectionRegistry } from "@nanobpm/agentic/channel";
import type { Frame } from "@nanobpm/agentic/protocol";
import { RELAY_FAMILY } from "@nanobpm/agentic/relay";
import { type SqliteDb, TRANSCRIPT_SCHEMA_SQL } from "@nanobpm/agentic/transcript";
import { assert, assertEquals } from "#test-assert";
import { noopLog } from "../../../test/log.ts";
import {
  createRelayFamily,
  currentRelayTranscriptService,
  family as relayFamily,
  RELAY_FAMILY_NAME,
  RelayTranscriptService,
} from "./relay.family.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** An in-memory {@link SqliteDb} over `node:sqlite`, matching the store's exec/run/all surface. */
function memoryDb(): SqliteDb {
  const raw = new DatabaseSync(":memory:");
  return {
    exec: (sql) => raw.exec(sql),
    run: (sql, params = []) => raw.prepare(sql).run(...params),
    all: <T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] =>
      raw.prepare(sql).all(...params) as T[],
  };
}

/** An in-memory {@link SqliteDb} whose exec/run/all can be flipped to throw, to exercise advisory resilience. */
function flakyDb(): { db: SqliteDb; fail: (on: boolean) => void } {
  const raw = new DatabaseSync(":memory:");
  let failing = false;
  const guard = <T>(fn: () => T): T => {
    if (failing) throw new Error("sqlite unavailable");
    return fn();
  };
  return {
    db: {
      exec: (sql) => guard(() => raw.exec(sql)),
      run: (sql, params = []) => guard(() => raw.prepare(sql).run(...params)),
      all: <T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] =>
        guard(() => raw.prepare(sql).all(...params) as T[]),
    },
    fail: (on: boolean) => {
      failing = on;
    },
  };
}

/** A hub double that just captures the family handler so the test can drive frames directly. */
interface CapturingHub {
  handler?: (frame: Frame, conn: RelayConn) => void;
  registerFamilyHandler(family: string, handler: (frame: Frame, conn: RelayConn) => void): void;
}

interface RelayConn {
  readonly id: string;
  readonly registry: { has(id: string): boolean };
  send(frame: Frame): void;
}

function capturingHub(): CapturingHub {
  return {
    registerFamilyHandler(_family, handler) {
      this.handler = handler;
    },
  };
}

/** A live fake connection registered in `registry`, collecting frames the hub sends back to it. */
function connect(id: string, registry: ConnectionRegistry): { conn: RelayConn; sent: Frame[] } {
  registry.add(id, `identity:${id}`);
  const sent: Frame[] = [];
  return { conn: { id, registry, send: (f) => sent.push(f) }, sent };
}

const produce = (stream: string, incarnation: number, chunk: string): Frame => ({
  lane: "bulk",
  family: RELAY_FAMILY,
  seq: 0,
  payload: { op: "produce", stream, incarnation, chunk },
});
const subscribe = (stream: string, from: number, credit: number): Frame => ({
  lane: "control",
  family: RELAY_FAMILY,
  seq: 0,
  payload: { op: "subscribe", stream, from, credit },
});
const grant = (credit: number): Frame => ({
  lane: "control",
  family: RELAY_FAMILY,
  seq: 0,
  payload: { op: "credit", credit },
});

/** Read the `op` marker off a delivered frame payload without an unsafe cast. */
function payloadOp(frame: Frame): unknown {
  const p = frame.payload;
  return p && typeof p === "object" && Object.hasOwn(p, "op")
    ? Object.getOwnPropertyDescriptor(p, "op")?.value
    : undefined;
}
function payloadField(frame: Frame, key: string): unknown {
  const p = frame.payload;
  return p && typeof p === "object" && Object.hasOwn(p, key)
    ? Object.getOwnPropertyDescriptor(p, key)?.value
    : undefined;
}

function mkService(registry: ConnectionRegistry, db: SqliteDb | undefined): {
  service: RelayTranscriptService;
  hub: CapturingHub;
} {
  const hub = capturingHub();
  const service = new RelayTranscriptService({ hub, registry, db, log: noopLog() });
  return { service, hub };
}

test("the family exports a valid AgenticFamily named 'relay'", () => {
  assertEquals(relayFamily.name, RELAY_FAMILY_NAME);
  assertEquals(relayFamily.name, "relay");
  assertEquals(typeof relayFamily.mount, "function");
  assertEquals(typeof relayFamily.teardown, "function");
  // createRelayFamily builds an independent instance with the same contract.
  const another = createRelayFamily();
  assertEquals(another.name, "relay");
});

test("ring resume: a late consumer replays from an offset with no loss or duplication", () => {
  const registry = new ConnectionRegistry();
  const { service, hub } = mkService(registry, memoryDb());
  const p = connect("prod", registry);
  for (let i = 0; i < 5; i++) hub.handler?.(produce("s", 1, `c${i}`), p.conn);

  // A late consumer resumes from offset 2 with ample credit → gets exactly offsets 2,3,4 in order.
  const late = connect("late", registry);
  hub.handler?.(subscribe("s", 2, 100), late.conn);

  const acks = late.sent.filter((f) => payloadOp(f) === "subscribed");
  assertEquals(acks.length, 1);
  assertEquals(payloadField(acks[0], "gap"), false);
  assertEquals(payloadField(acks[0], "nextOffset"), 5);

  const data = late.sent.filter((f) => payloadOp(f) === undefined); // data frames carry {stream,offset,chunk}
  assertEquals(
    data.map((f) => payloadField(f, "offset")),
    [2, 3, 4],
  );
  assertEquals(
    data.map((f) => payloadField(f, "chunk")),
    ["c2", "c3", "c4"],
  );

  // A reconnect from 0 gets the whole retained window — still gap-free, no duplication.
  const full = connect("full", registry);
  hub.handler?.(subscribe("s", 0, 100), full.conn);
  const fullData = full.sent.filter((f) => payloadOp(f) === undefined);
  assertEquals(
    fullData.map((f) => payloadField(f, "offset")),
    [0, 1, 2, 3, 4],
  );
  service.teardown();
});

test("lane priority: a bulk storm never head-of-line-blocks a control frame", () => {
  const registry = new ConnectionRegistry();
  const { service, hub } = mkService(registry, memoryDb());
  const p = connect("prod", registry);

  // Consumer subscribes to stream A with ZERO bulk credit: it gets the control ack but no bulk.
  const c = connect("cons", registry);
  hub.handler?.(subscribe("A", 0, 0), c.conn);
  assertEquals(c.sent.filter((f) => payloadOp(f) === "subscribed").length, 1);

  // A bulk-output storm on A: every produce enqueues a bulk data frame, all credit-gated (buffered).
  for (let i = 0; i < 200; i++) hub.handler?.(produce("A", 1, `x${i}`), p.conn);
  const bulkBefore = c.sent.filter((f) => payloadOp(f) === undefined).length;
  assertEquals(bulkBefore, 0, "bulk must stay buffered with zero credit — never force-flushed");

  // A control-lane heartbeat (a second subscribe) MUST get through despite the buffered bulk backlog.
  hub.handler?.(subscribe("B", 0, 0), c.conn);
  assertEquals(
    c.sent.filter((f) => payloadOp(f) === "subscribed").length,
    2,
    "control ack delivered ahead of the bulk backlog — control is never starved",
  );
  assertEquals(c.sent.filter((f) => payloadOp(f) === undefined).length, 0);

  // Granting credit now releases the buffered bulk — nothing was lost, order preserved.
  hub.handler?.(grant(300), c.conn);
  const released = c.sent.filter((f) => payloadOp(f) === undefined);
  assertEquals(released.length, 200);
  assertEquals(payloadField(released[0], "chunk"), "x0");
  assertEquals(payloadField(released[199], "chunk"), "x199");
  service.teardown();
});

test("retention: an ephemeral stream's transcript is persisted on completion, then swept", () => {
  const registry = new ConnectionRegistry();
  const db = memoryDb();
  const clock = { t: 1_000_000 };
  const hub = capturingHub();
  const service = new RelayTranscriptService({
    hub,
    registry,
    db,
    log: noopLog(),
    transcript: { ephemeralRetentionMs: 1000, clock: { now: () => clock.t } },
  });
  const p = connect("prod", registry);
  for (let i = 0; i < 3; i++) hub.handler?.(produce("job-1", 1, `l${i}`), p.conn);

  const flushed = service.completeStream("job-1");
  assertEquals(flushed, 3);
  const meta = service.transcriptOf("job-1");
  assertEquals(meta?.lifecycle, "ephemeral");
  assertEquals(meta?.status, "completed");
  assertEquals(service.reattach("job-1", 0)?.entries.length, 3);

  // Before the retention window elapses the sweep keeps it; after, it retires the transcript.
  clock.t += 500;
  assertEquals(service.sweep(), []);
  clock.t += 1000;
  assertEquals(service.sweep(), ["job-1"]);
  assertEquals(service.transcriptOf("job-1"), undefined);
  assert(!service.streams().includes("job-1"), "sweep forgets retired stream state — map stays bounded");
  service.teardown();
});

test("retention: a disconnected producer auto-completes its ephemeral stream on the next frame", () => {
  const registry = new ConnectionRegistry();
  const db = memoryDb();
  const { service, hub } = mkService(registry, db);
  const p = connect("prod", registry);
  for (let i = 0; i < 2; i++) hub.handler?.(produce("job-2", 1, `m${i}`), p.conn);
  assertEquals(service.transcriptOf("job-2"), undefined, "not yet flushed while producer is live");

  // Producer drops (S1 registry removed it on close/timeout). A subsequent inbound frame from any
  // live connection reconciles the dead producer and flushes+completes its ephemeral stream.
  registry.remove("prod");
  const other = connect("cons", registry);
  hub.handler?.(grant(0), other.conn); // any frame drives #reconcile

  const meta = service.transcriptOf("job-2");
  assertEquals(meta?.status, "completed");
  assertEquals(service.reattach("job-2", 0)?.entries.length, 2);
  service.teardown();
});

test("retention: a long-lived stream is checkpointed + reattachable and never auto-completed", () => {
  const registry = new ConnectionRegistry();
  const db = memoryDb();
  const { service, hub } = mkService(registry, db);
  service.declareLifecycle("ctrl", "long-lived");
  const p = connect("prod", registry);
  for (let i = 0; i < 4; i++) hub.handler?.(produce("ctrl", 1, `k${i}`), p.conn);

  const n = service.checkpointStream("ctrl");
  assertEquals(n, 4);
  assertEquals(service.transcriptOf("ctrl")?.status, "open");
  assertEquals(service.reattach("ctrl", 2)?.entries.map((e) => e.chunk), ["k2", "k3"]);

  // Producer drop must NOT complete a long-lived stream — it stays open for reattach.
  registry.remove("prod");
  const other = connect("cons", registry);
  hub.handler?.(grant(0), other.conn);
  assertEquals(service.transcriptOf("ctrl")?.status, "open");

  // The retention sweep never time-retires an open long-lived stream.
  assertEquals(service.sweep(2_000_000_000_000), []);
  assertEquals(service.transcriptOf("ctrl")?.status, "open");
  service.teardown();
});

test("teardown flushes still-open ephemeral streams so nothing in-flight is lost", () => {
  const registry = new ConnectionRegistry();
  const db = memoryDb();
  const { service, hub } = mkService(registry, db);
  const p = connect("prod", registry);
  hub.handler?.(produce("open-job", 1, "z0"), p.conn);
  assertEquals(service.transcriptOf("open-job"), undefined);

  service.teardown();
  assertEquals(service.transcriptOf("open-job")?.status, "completed");
});

test("advisory mode: with no DataLayer the relay still replays; persistence is a no-op", () => {
  const registry = new ConnectionRegistry();
  const { service, hub } = mkService(registry, undefined);
  const p = connect("prod", registry);
  for (let i = 0; i < 3; i++) hub.handler?.(produce("s", 1, `n${i}`), p.conn);

  const c = connect("cons", registry);
  hub.handler?.(subscribe("s", 0, 100), c.conn);
  const data = c.sent.filter((f) => payloadOp(f) === undefined);
  assertEquals(data.length, 3, "relay replay works without a store — advisory-correct");

  assertEquals(service.completeStream("s"), 0);
  assertEquals(service.reattach("s", 0), undefined);
  assertEquals(service.sweep(), []);
  service.teardown();
});

test("incarnation fencing: a stale producer cannot overwrite a newer incarnation's stream", () => {
  const registry = new ConnectionRegistry();
  const { service, hub } = mkService(registry, memoryDb());
  const p = connect("prod", registry);
  hub.handler?.(produce("s", 2, "new-a"), p.conn); // incarnation 2 establishes the mark
  hub.handler?.(produce("s", 1, "stale"), p.conn); // incarnation 1 is fenced (dropped)
  hub.handler?.(produce("s", 2, "new-b"), p.conn);

  const c = connect("cons", registry);
  hub.handler?.(subscribe("s", 0, 100), c.conn);
  const chunks = c.sent.filter((f) => payloadOp(f) === undefined).map((f) => payloadField(f, "chunk"));
  assertEquals(chunks, ["new-a", "new-b"], "the stale incarnation's chunk never entered the ring");
  service.teardown();
});

test("advisory mode: a store that fails to initialize falls back to unpersisted — mount never throws", () => {
  const registry = new ConnectionRegistry();
  const { db, fail } = flakyDb();
  fail(true); // schema application throws during construction
  const hub = capturingHub();
  const service = new RelayTranscriptService({ hub, registry, db, log: noopLog() });
  assertEquals(service.store, undefined, "store setup failure falls back to unpersisted, not a thrown mount");

  // The relay still replays — advisory-correct even with no store.
  const p = connect("prod", registry);
  for (let i = 0; i < 3; i++) hub.handler?.(produce("s", 1, `n${i}`), p.conn);
  const c = connect("cons", registry);
  hub.handler?.(subscribe("s", 0, 100), c.conn);
  assertEquals(c.sent.filter((f) => payloadOp(f) === undefined).length, 3);
  assertEquals(service.completeStream("s"), 0);
  service.teardown();
});

test("advisory resilience: a flush failure leaves the ephemeral stream uncompleted and never bubbles", () => {
  const registry = new ConnectionRegistry();
  const { db, fail } = flakyDb();
  const hub = capturingHub();
  const service = new RelayTranscriptService({ hub, registry, db, log: noopLog() });
  const p = connect("prod", registry);
  for (let i = 0; i < 2; i++) hub.handler?.(produce("job", 1, `c${i}`), p.conn);

  fail(true);
  assertEquals(service.completeStream("job"), 0, "flush failure is swallowed and returns 0");

  // Left uncompleted: once the store recovers, a later completion flushes the whole window.
  fail(false);
  assertEquals(service.completeStream("job"), 2);
  assertEquals(service.transcriptOf("job")?.status, "completed");
  service.teardown();
});

test("advisory resilience: a checkpoint flush failure keeps the long-lived stream open and returns 0", () => {
  const registry = new ConnectionRegistry();
  const { db, fail } = flakyDb();
  const hub = capturingHub();
  const service = new RelayTranscriptService({ hub, registry, db, log: noopLog() });
  service.declareLifecycle("ctrl", "long-lived");
  const p = connect("prod", registry);
  for (let i = 0; i < 3; i++) hub.handler?.(produce("ctrl", 1, `k${i}`), p.conn);

  fail(true);
  assertEquals(service.checkpointStream("ctrl"), 0, "checkpoint failure is swallowed and returns 0");

  fail(false);
  assertEquals(service.checkpointStream("ctrl"), 3);
  assertEquals(service.transcriptOf("ctrl")?.status, "open");
  service.teardown();
});

test("mount installs the service singleton for the read path and teardown clears it (#222)", () => {
  const registry = new ConnectionRegistry();
  const ctx = {
    hub: capturingHub() as never,
    registry: registry as never,
    transport: undefined as never,
    data: { source: () => ({ db: memoryDb() }) } as never,
    log: noopLog(),
  };
  const family = createRelayFamily();
  assertEquals(currentRelayTranscriptService(), undefined, "no singleton before mount");
  family.mount(ctx);
  const service = currentRelayTranscriptService();
  assert(service !== undefined, "mount installs the singleton the read endpoints source");
  assert(service.store !== undefined, "the mounted service is persisted");
  family.teardown?.();
  assertEquals(currentRelayTranscriptService(), undefined, "teardown clears the singleton");
});

test("mount drives a retention sweep so completed-ephemeral transcripts are retired (#222)", () => {
  const registry = new ConnectionRegistry();
  // A tiny retention window + a clock we control: complete an ephemeral stream, advance past retention,
  // then confirm the family's own sweep surface retires it (the periodic tick calls the same path).
  let nowMs = 1_000_000;
  const ctx = {
    hub: capturingHub() as never,
    registry: registry as never,
    transport: undefined as never,
    data: { source: () => ({ db: memoryDb() }) } as never,
    log: noopLog(),
  };
  const family = createRelayFamily({ transcript: { ephemeralRetentionMs: 10, clock: { now: () => nowMs } } });
  family.mount(ctx);
  const service = currentRelayTranscriptService();
  assert(service !== undefined);
  service.store?.flush("job:9", { since: () => ({ entries: [{ offset: 0, chunk: "x" }] }), nextOffset: 1 }, "ephemeral");
  assertEquals(service.transcriptOf("job:9")?.status, "completed");
  nowMs += 1000; // advance well past the 10ms retention window
  const retired = service.sweep();
  assertEquals(retired, ["job:9"], "the completed-ephemeral transcript is retired past retention");
  assertEquals(service.transcriptOf("job:9"), undefined);
  family.teardown?.();
});

test("drift guard: migration 024 mirrors the canonical transcript DDL byte-for-byte", async () => {
  const migrationPath = join(HERE, "..", "..", "..", "db", "migrations", "024_agentic_transcript.sql");
  const raw = await readFile(migrationPath, "utf8");
  // Strip `-- …` comment lines; the DDL is the remaining statements.
  const ddl = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const normalise = (s: string) => s.trim().replace(/\s+/g, " ");
  assertEquals(
    normalise(ddl),
    normalise(TRANSCRIPT_SCHEMA_SQL),
    "024_agentic_transcript.sql drifted from @nanobpm/agentic/transcript TRANSCRIPT_SCHEMA_SQL",
  );
  assert(ddl.includes("agentic_transcript_stream"));
  assert(ddl.includes("agentic_transcript_chunk"));
});
