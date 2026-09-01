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
import { encodeTranscriptEvent, type SqliteDb, TRANSCRIPT_SCHEMA_SQL } from "@nanobpm/agentic/transcript";
import { assert, assertEquals } from "#test-assert";
import { noopLog } from "../../../test/log.ts";
import { CorrelationRegistry, jobStream } from "../correlation.ts";
import { AgenticCorrelationStore } from "../correlation-store.ts";
import { createPresenceStore, PresenceRegistry } from "./presence.family.ts";
import {
  type CorrelationLink,
  createRelayFamily,
  currentRelayTranscriptService,
  engineReconcileMs,
  family as relayFamily,
  RELAY_FAMILY_NAME,
  RelayTranscriptService,
  sweepIntervalMs,
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

/** Flush the microtask/macrotask queue so a fire-and-forget promise chain (the async #544 element-
 * instance resolution) settles before the test asserts on its effects. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Build a service with the H6 correlation write-side wired (a real registry + a connection→instance map). */
function mkCorrelatedService(
  registry: ConnectionRegistry,
  db: SqliteDb | undefined,
  correlation: CorrelationRegistry,
  byConnection: Map<string, string>,
  extra: {
    attributionForInstance?: (instance: string) => { identity?: string; host?: string } | undefined;
    correlationStore?: AgenticCorrelationStore;
    resolveElementInstance?: (jobKey: string, processInstanceKey?: string) => Promise<string | undefined>;
    now?: () => string;
  } = {},
): { service: RelayTranscriptService; hub: CapturingHub } {
  const hub = capturingHub();
  const service = new RelayTranscriptService({
    hub,
    registry,
    db,
    log: noopLog(),
    correlation: () => correlation,
    instanceForConnection: (id) => byConnection.get(id),
    attributionForInstance: extra.attributionForInstance,
    correlationStore: extra.correlationStore,
    resolveElementInstance: extra.resolveElementInstance,
    now: extra.now,
  });
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

test("#486 live fallback: an uncompleted stream's ring is served pre-flush, then yields to the durable store", () => {
  const registry = new ConnectionRegistry();
  const hub = capturingHub();
  const service = new RelayTranscriptService({
    hub,
    registry,
    db: memoryDb(),
    log: noopLog(),
    now: () => "2026-03-04T05:06:07.000Z",
  });
  const p = connect("prod", registry);
  for (let i = 0; i < 3; i++) hub.handler?.(produce(jobStream("Lk1"), 1, `r${i}`), p.conn);

  // The job has completed and emitted its transcriptUrl, but this multiplexing worker is still live so
  // no disconnect/supersede flushed the ring — the durable store still 404s (#486). The live fallback
  // exposes the captured ring + its opened-at instant so the read path can serve it immediately.
  assertEquals(service.transcriptOf(jobStream("Lk1")), undefined, "not yet flushed while the worker is live");
  const live = service.liveFallback(jobStream("Lk1"));
  assert(live !== undefined, "a live, unflushed stream has a serveable ring");
  assertEquals(live.createdAt, "2026-03-04T05:06:07.000Z", "createdAt is the stream's opened-at instant");
  assertEquals(live.ring.since(0).entries.length, 3, "the whole captured window is available");
  assertEquals(live.ring.nextOffset, 3);

  // Once the stream completes (flushed to durable), the durable store is the source of truth and the
  // live fallback steps aside so a completed transcript is never double-sourced.
  service.completeStream(jobStream("Lk1"));
  assertEquals(service.transcriptOf(jobStream("Lk1"))?.status, "completed");
  assertEquals(service.liveFallback(jobStream("Lk1")), undefined, "a completed stream no longer falls back to the ring");
  service.teardown();
});

test("H6 correlation write-side: a produce on job:<k> links instance→[k]; stream completion releases it", () => {
  const registry = new ConnectionRegistry();
  const correlation = new CorrelationRegistry();
  const byConnection = new Map([["prod", "worker-A"]]);
  const { service, hub } = mkCorrelatedService(registry, memoryDb(), correlation, byConnection);
  const p = connect("prod", registry);

  // The first `produce` for a job-scoped stream links the producing worker instance → jobKey, from
  // data already crossing the wire (jobKey decoded from the stream id; instance from the connection).
  hub.handler?.(produce(jobStream("k1"), 1, "chunk"), p.conn);
  assertEquals(correlation.jobKeysFor("worker-A"), ["k1"], "instance → [jobKey] is now linked");
  assertEquals(correlation.resolve("k1")?.stream, jobStream("k1"), "context carries the job-scoped stream");
  assertEquals(correlation.count(), 1);

  // Job end (stream completion) releases the correlation, so the worker's supply row clears it.
  service.completeStream(jobStream("k1"));
  assertEquals(correlation.jobKeysFor("worker-A"), [], "completion releases the job");
  assertEquals(correlation.resolve("k1"), undefined);
  assertEquals(correlation.count(), 0);
  service.teardown();
});

test("H6 correlation write-side: an unpersisted stream completion releases its job correlation and stops reconcile retrying", () => {
  const registry = new ConnectionRegistry();
  const correlation = new CorrelationRegistry();
  const byConnection = new Map([["prod", "worker-U"]]);
  // No DataLayer → the relay runs unpersisted. A direct completeStream (job end, not a disconnect)
  // must still transition in-memory state: unlink correlation, mark ephemeral completed, drop the
  // producer — otherwise #reconcile keeps re-completing the stream on every subsequent frame.
  const { service, hub } = mkCorrelatedService(registry, undefined, correlation, byConnection);
  const p = connect("prod", registry);
  hub.handler?.(produce(jobStream("kU"), 1, "x"), p.conn);
  assertEquals(correlation.jobKeysFor("worker-U"), ["kU"]);

  service.completeStream(jobStream("kU"));
  assertEquals(correlation.jobKeysFor("worker-U"), [], "unpersisted completion releases the job");
  assertEquals(correlation.count(), 0);

  // The producer is still live, but the stream is now completed: a later frame's #reconcile must not
  // re-link or otherwise resurrect the released correlation.
  hub.handler?.(grant(0), p.conn);
  assertEquals(correlation.count(), 0, "completed stream stays released; reconcile does not retry");
  service.teardown();
});

test("H6 correlation write-side: a late produce after completion does not resurrect the released correlation", () => {
  const registry = new ConnectionRegistry();
  const correlation = new CorrelationRegistry();
  const byConnection = new Map([["prod", "worker-R"]]);
  const { service, hub } = mkCorrelatedService(registry, undefined, correlation, byConnection);
  const p = connect("prod", registry);
  hub.handler?.(produce(jobStream("kR"), 1, "x"), p.conn);
  assertEquals(correlation.jobKeysFor("worker-R"), ["kR"]);

  // Job end completes the stream and releases the correlation.
  service.completeStream(jobStream("kR"));
  assertEquals(correlation.count(), 0, "completion releases the job");

  // A late `produce` frame for the same, still-live producer must NOT re-link/re-own the completed
  // stream — otherwise it resurrects a jobKey after it was released.
  hub.handler?.(produce(jobStream("kR"), 1, "late"), p.conn);
  assertEquals(correlation.count(), 0, "a late produce does not resurrect a completed stream");
  assertEquals(correlation.jobKeysFor("worker-R"), [], "released jobKey stays released after a late produce");
  service.teardown();
});

test("H6 correlation write-side: a worker starting a NEW job over its live connection supersedes its prior job", () => {
  const registry = new ConnectionRegistry();
  const correlation = new CorrelationRegistry();
  // One worker, ONE long-lived connection — exactly the fleet reality: a worker relays every job it
  // runs over the same channel connection, one job at a time (correlation.ts). The connection never
  // disconnects between jobs, so the disconnect-driven #reconcile release never fires; without a
  // supersede-on-next-job rule the worker's supply row would accumulate EVERY job it ever ran.
  const byConnection = new Map([["prod", "worker-A"]]);
  const { service, hub } = mkCorrelatedService(registry, memoryDb(), correlation, byConnection);
  const p = connect("prod", registry);

  // Job 1: the worker relays k1's terminal → linked.
  hub.handler?.(produce(jobStream("k1"), 1, "job-1 line"), p.conn);
  assertEquals(correlation.jobKeysFor("worker-A"), ["k1"], "job 1 is the current job");

  // Job 2 begins on the SAME live connection (no disconnect). The worker relaying k2's terminal PROVES
  // k1 finished (one job at a time) → k1 is superseded: released AND flushed to a durable past session.
  hub.handler?.(produce(jobStream("k2"), 1, "job-2 line"), p.conn);
  assertEquals(correlation.jobKeysFor("worker-A"), ["k2"], "the supply row shows ONLY the current job — no accumulation");
  assertEquals(correlation.resolve("k1"), undefined, "the prior job's correlation is released");
  assertEquals(correlation.count(), 1);

  // The superseded job is not lost — its transcript is flushed and completed, i.e. a replayable past session.
  const priorMeta = service.transcriptOf(jobStream("k1"));
  assertEquals(priorMeta?.status, "completed", "the superseded job becomes a completed past session");
  assertEquals(service.reattach(jobStream("k1"), 0)?.entries.length, 1, "the past session replays its captured terminal");
  service.teardown();
});

test("H6 durable attribution: completing/superseding a job persists the worker's attribution to the correlation store", () => {
  const registry = new ConnectionRegistry();
  const correlation = new CorrelationRegistry();
  const db = memoryDb();
  const store = new AgenticCorrelationStore(db);
  const byConnection = new Map([["prod", "worker-A"]]);
  // The presence-backed resolver: worker-A's durable identity/host, available while it is registered
  // but gone once it exits — which is exactly why the job's attribution must be persisted at completion.
  const attributionForInstance = (instance: string) =>
    instance === "worker-A" ? { identity: "gpu-box-7", host: "us-east-1a" } : undefined;
  const { service, hub } = mkCorrelatedService(registry, db, correlation, byConnection, {
    attributionForInstance,
    correlationStore: store,
    now: () => "2024-01-02T03:04:05.000Z",
  });
  const p = connect("prod", registry);

  // Job 1 runs, then the worker starts job 2 on the same live connection → job 1 is superseded and
  // released. Its attribution must be durably recorded BEFORE the live correlation forgets it.
  hub.handler?.(produce(jobStream("k1"), 1, "job-1 line"), p.conn);
  hub.handler?.(produce(jobStream("k2"), 1, "job-2 line"), p.conn);

  const durable = store.get("k1");
  assert(durable !== undefined, "the superseded job's attribution is persisted");
  assertEquals(durable?.instance, "worker-A");
  assertEquals(durable?.identity, "gpu-box-7");
  assertEquals(durable?.host, "us-east-1a");
  assertEquals(durable?.stream, jobStream("k1"));
  assertEquals(durable?.completedAt, "2024-01-02T03:04:05.000Z");
  // The still-active job is NOT yet recorded (attribution is written on completion, not on link).
  assertEquals(store.get("k2"), undefined, "the active job has no completion attribution yet");
  service.teardown();
});

test("#544 element-instance enrichment: link-time resolution keys the completed session on the element instance", async () => {
  const registry = new ConnectionRegistry();
  const correlation = new CorrelationRegistry();
  const db = memoryDb();
  const store = new AgenticCorrelationStore(db);
  const byConnection = new Map([["prod", "worker-A"]]);
  // The engine resolves job k1's live JOB park to element instance ei-1 (resolution wins the race,
  // i.e. it returns while the job is still live — the common case for a long-lived agent job).
  const resolveElementInstance = (jobKey: string) =>
    Promise.resolve(jobKey === "k1" ? "ei-1" : undefined);
  const { service, hub } = mkCorrelatedService(registry, db, correlation, byConnection, {
    correlationStore: store,
    resolveElementInstance,
    now: () => "2024-01-02T03:04:05.000Z",
  });
  const p = connect("prod", registry);

  // First produce links the job and fires the (async) element-instance resolution.
  hub.handler?.(produce(jobStream("k1"), 1, "job-1 line"), p.conn);
  await tick();
  // The live correlation context is enriched while the job runs.
  assertEquals(correlation.resolve("k1")?.elementInstanceKey, "ei-1", "the live context carries the element instance");

  // Superseding with a new job completes k1 → its attribution persists WITH the element-instance key.
  hub.handler?.(produce(jobStream("k2"), 1, "job-2 line"), p.conn);
  const durable = store.get("k1");
  assertEquals(durable?.elementInstanceKey, "ei-1", "the completed session is keyed on the element instance");
  service.teardown();
});

test("#544 element-instance enrichment: a resolution that lands AFTER completion backfills the durable row", async () => {
  const registry = new ConnectionRegistry();
  const correlation = new CorrelationRegistry();
  const db = memoryDb();
  const store = new AgenticCorrelationStore(db);
  const byConnection = new Map([["prod", "worker-A"]]);
  // A deferred resolution the test releases MANUALLY, to force the race where the element-instance
  // key arrives only after the job already completed and released its live correlation.
  let release: (key: string | undefined) => void = () => {};
  const pending = new Promise<string | undefined>((resolve) => {
    release = resolve;
  });
  const { service, hub } = mkCorrelatedService(registry, db, correlation, byConnection, {
    correlationStore: store,
    resolveElementInstance: () => pending,
  });
  const p = connect("prod", registry);

  // Link job k1 (fires the still-pending resolution), then supersede it → k1 completes and persists
  // its attribution BEFORE the element instance is known.
  hub.handler?.(produce(jobStream("k1"), 1, "job-1 line"), p.conn);
  hub.handler?.(produce(jobStream("k2"), 1, "job-2 line"), p.conn);
  assertEquals(store.get("k1")?.elementInstanceKey, undefined, "persisted before the element instance resolved");
  assertEquals(correlation.resolve("k1"), undefined, "k1's live correlation was already released");

  // The resolution finally lands — it backfills the durable row directly (the live context is gone).
  release("ei-late");
  await tick();
  assertEquals(store.get("k1")?.elementInstanceKey, "ei-late", "the durable row is backfilled after the fact");
  service.teardown();
});

test("#544 element-instance enrichment: an unresolved job (never parked) leaves the session un-keyed, not erroring", async () => {
  const registry = new ConnectionRegistry();
  const correlation = new CorrelationRegistry();
  const db = memoryDb();
  const store = new AgenticCorrelationStore(db);
  const byConnection = new Map([["prod", "worker-A"]]);
  const { service, hub } = mkCorrelatedService(registry, db, correlation, byConnection, {
    correlationStore: store,
    resolveElementInstance: () => Promise.resolve(undefined),
  });
  const p = connect("prod", registry);
  hub.handler?.(produce(jobStream("k1"), 1, "job-1 line"), p.conn);
  await tick();
  hub.handler?.(produce(jobStream("k2"), 1, "job-2 line"), p.conn);
  const durable = store.get("k1");
  assert(durable !== undefined, "the session is still attributed");
  assertEquals(durable?.elementInstanceKey, undefined, "no element-instance key when the job was not resolvable");
  service.teardown();
});

/** A `produce` frame whose chunk is a typed transcript LIFECYCLE event at `phase` (#661). */
const lifecycle = (stream: string, incarnation: number, phase: "open" | "completed" | "exited"): Frame =>
  produce(stream, incarnation, encodeTranscriptEvent({ kind: "lifecycle", phase, offset: 0 }));

test("#661 primary release: a terminal lifecycle event clears an idle-but-connected worker's finished job", () => {
  const registry = new ConnectionRegistry();
  const correlation = new CorrelationRegistry();
  const byConnection = new Map([["prod", "worker-A"]]);
  const { service, hub } = mkCorrelatedService(registry, memoryDb(), correlation, byConnection);
  const p = connect("prod", registry);

  // The worker relays its job's terminal → linked as active.
  hub.handler?.(produce(jobStream("k1"), 1, "job-1 line"), p.conn);
  assertEquals(correlation.jobKeysFor("worker-A"), ["k1"], "the job is active while it runs");
  assertEquals(correlation.count(), 1);

  // The job ends: the worker emits the terminal `lifecycle` event on the SAME live connection and then
  // goes idle — it does NOT disconnect and does NOT take a new job (no supersede). Before this fix that
  // finished job lingered forever as a phantom active job; now the terminal event releases it.
  hub.handler?.(lifecycle(jobStream("k1"), 1, "completed"), p.conn);
  assertEquals(correlation.jobKeysFor("worker-A"), [], "the finished job is released on the terminal event");
  assertEquals(correlation.count(), 0, "count() drops — no phantom active job");

  // Assert the RENDERED supply row clears too (not just the registry): the presence snapshot seeds
  // per-worker jobKeys from the correlation registry, so an idle-but-connected worker shows no job.
  const store = createPresenceStore(memoryDb());
  store.ensureSchema();
  store.register({ instance: "worker-A", connectionId: "prod", identity: "leaf", capability: {} });
  const presence = new PresenceRegistry(store, () => new Set(["prod"]));
  const row = presence.snapshot({ jobKeysFor: (i) => correlation.jobKeysFor(i) }).workers[0];
  assertEquals(row.jobKeys, [], "the supply row shows no active job for the idle worker");
  assert(row.live, "the worker is still connected — the connection persists across jobs");

  // The terminal event itself is captured in the flushed transcript (release runs AFTER the ring append).
  const meta = service.transcriptOf(jobStream("k1"));
  assertEquals(meta?.status, "completed", "the finished job becomes a completed past session");
  assertEquals(service.reattach(jobStream("k1"), 0)?.entries.length, 2, "the terminal event is part of the transcript");
  service.teardown();
});

test("#661 primary release: an `exited` lifecycle also releases; a non-terminal `open` does not", () => {
  const registry = new ConnectionRegistry();
  const correlation = new CorrelationRegistry();
  const byConnection = new Map([["prod", "worker-A"]]);
  const { service, hub } = mkCorrelatedService(registry, memoryDb(), correlation, byConnection);
  const p = connect("prod", registry);

  hub.handler?.(produce(jobStream("k1"), 1, "job-1 line"), p.conn);
  // A `phase: "open"` lifecycle is NOT terminal — a genuinely active job must not be cleared.
  hub.handler?.(lifecycle(jobStream("k1"), 1, "open"), p.conn);
  assertEquals(correlation.jobKeysFor("worker-A"), ["k1"], "an open lifecycle keeps the active job");
  assertEquals(correlation.count(), 1);

  // An `exited` lifecycle (a crash/kill the worker still managed to report) IS terminal → released.
  hub.handler?.(lifecycle(jobStream("k1"), 1, "exited"), p.conn);
  assertEquals(correlation.jobKeysFor("worker-A"), [], "an exited lifecycle releases the job");
  assertEquals(correlation.count(), 0);
  service.teardown();
});

test("#661 no-regression: an ordinary (non-lifecycle) chunk never clears a genuinely active job", () => {
  const registry = new ConnectionRegistry();
  const correlation = new CorrelationRegistry();
  const byConnection = new Map([["prod", "worker-A"]]);
  const { service, hub } = mkCorrelatedService(registry, memoryDb(), correlation, byConnection);
  const p = connect("prod", registry);

  hub.handler?.(produce(jobStream("k1"), 1, "job-1 line"), p.conn);
  // Ordinary terminal output (raw bytes, not a typed envelope) must NOT be read as a job-end signal.
  for (let i = 0; i < 5; i++) hub.handler?.(produce(jobStream("k1"), 1, `output ${i}`), p.conn);
  assertEquals(correlation.jobKeysFor("worker-A"), ["k1"], "a running job stays active across ordinary output");
  assertEquals(correlation.count(), 1);
  assertEquals(service.transcriptOf(jobStream("k1")), undefined, "the live job is not completed");
  service.teardown();
});

test("#661 defensive reconcile: an unclean exit (no lifecycle) whose engine job is gone is dropped by the reconcile pass", async () => {
  const registry = new ConnectionRegistry();
  const correlation = new CorrelationRegistry();
  const byConnection = new Map([["prod", "worker-A"]]);
  // The engine reports job k1 as a live JOB park (element instance ei-1) — until the worker exits
  // UNCLEANLY (crash/kill): it emits no terminal lifecycle event, keeps no connection to reconcile,
  // and the engine park is gone → the resolver returns undefined.
  let parked = true;
  const resolveElementInstance = (jobKey: string) =>
    Promise.resolve(parked && jobKey === "k1" ? "ei-1" : undefined);
  const { service, hub } = mkCorrelatedService(registry, memoryDb(), correlation, byConnection, {
    resolveElementInstance,
  });
  const p = connect("prod", registry);

  hub.handler?.(produce(jobStream("k1"), 1, "job-1 line"), p.conn);
  assertEquals(correlation.jobKeysFor("worker-A"), ["k1"], "the job links while it runs");

  // While the engine still parks the job, the reconcile pass leaves a genuinely active job alone.
  await service.reconcileEngineCorrelations();
  assertEquals(correlation.jobKeysFor("worker-A"), ["k1"], "a genuinely active job is NOT cleared by the safety net");
  assertEquals(correlation.count(), 1);

  // The worker exits uncleanly (no lifecycle event) — its engine park vanishes. The next reconcile
  // pass drops the stale correlation even though nothing on the wire signalled job end.
  parked = false;
  await service.reconcileEngineCorrelations();
  assertEquals(correlation.jobKeysFor("worker-A"), [], "the reconcile pass drops the stale correlation");
  assertEquals(correlation.count(), 0, "no phantom active job survives an unclean exit");
  service.teardown();
});

test("#661 defensive reconcile: a transient engine read failure never falsely releases a job", async () => {
  const registry = new ConnectionRegistry();
  const correlation = new CorrelationRegistry();
  const byConnection = new Map([["prod", "worker-A"]]);
  // The engine read throws (unavailable) — a transient fault must be treated as "unknown, keep it",
  // NEVER as "job gone", or a live job would be wrongly cleared on every engine blip.
  const resolveElementInstance = () => Promise.reject(new Error("engine unavailable"));
  const { service, hub } = mkCorrelatedService(registry, memoryDb(), correlation, byConnection, {
    resolveElementInstance,
  });
  const p = connect("prod", registry);
  hub.handler?.(produce(jobStream("k1"), 1, "job-1 line"), p.conn);

  await service.reconcileEngineCorrelations();
  assertEquals(correlation.jobKeysFor("worker-A"), ["k1"], "a transient engine failure leaves the job linked");
  assertEquals(correlation.count(), 1);
  service.teardown();
});

test("#661 defensive reconcile: a no-op when no engine resolver is wired", async () => {
  const registry = new ConnectionRegistry();
  const correlation = new CorrelationRegistry();
  const byConnection = new Map([["prod", "worker-A"]]);
  const { service, hub } = mkCorrelatedService(registry, memoryDb(), correlation, byConnection);
  const p = connect("prod", registry);
  hub.handler?.(produce(jobStream("k1"), 1, "job-1 line"), p.conn);

  // With no element-instance resolver (engine-less host), the safety net cannot query the engine —
  // it must be an inert no-op, leaving the correlation exactly as the primary path manages it.
  await service.reconcileEngineCorrelations();
  assertEquals(correlation.jobKeysFor("worker-A"), ["k1"], "no resolver → the reconcile pass is inert");
  service.teardown();
});

test("#661 engineReconcileMs: defaults, disables on a non-positive/non-finite value, caps at the timer max", () => {
  assertEquals(engineReconcileMs(), 30_000, "an omitted config uses the default cadence");
  assertEquals(engineReconcileMs(5_000), 5_000, "a finite positive value is honoured");
  assertEquals(engineReconcileMs(0), undefined, "zero disables the pass");
  assertEquals(engineReconcileMs(-1), undefined, "a negative value disables the pass");
  assertEquals(engineReconcileMs(Number.NaN), undefined, "a non-finite value disables the pass");
  assertEquals(engineReconcileMs(Number.POSITIVE_INFINITY), undefined, "infinity disables the pass");
  assertEquals(engineReconcileMs(2 ** 32), 2_147_483_647, "a huge value is capped at the Node timer ceiling");
});

/**
 * A {@link CorrelationLink} wrapper that delegates to a real registry but can be flipped to throw on
 * `link()`/`releaseJob()`, exercising the advisory-resilience contract: `#link`/`#unlink` are
 * documented "never throws into the frame handler", so a throwing injectable correlation must not
 * take down the relay frame handler, and the stream must stay retryable.
 */
function throwingCorrelation(inner: CorrelationRegistry): {
  correlation: CorrelationLink;
  failLink: (on: boolean) => void;
  failRelease: (on: boolean) => void;
} {
  let linkFails = false;
  let releaseFails = false;
  return {
    correlation: {
      link: (instance, jobKey, context) => {
        if (linkFails) throw new Error("correlation.link boom");
        inner.link(instance, jobKey, context);
      },
      releaseJob: (jobKey) => {
        if (releaseFails) throw new Error("correlation.releaseJob boom");
        inner.releaseJob(jobKey);
      },
    },
    failLink: (on) => {
      linkFails = on;
    },
    failRelease: (on) => {
      releaseFails = on;
    },
  };
}

test("H6 correlation write-side: a throwing correlation.link() never escapes the frame handler and leaves the stream retryable", () => {
  const registry = new ConnectionRegistry();
  const inner = new CorrelationRegistry();
  const { correlation, failLink } = throwingCorrelation(inner);
  const byConnection = new Map([["prod", "worker-L"]]);
  const hub = capturingHub();
  const service = new RelayTranscriptService({
    hub,
    registry,
    db: undefined,
    log: noopLog(),
    correlation: () => correlation,
    instanceForConnection: (id) => byConnection.get(id),
  });
  const p = connect("prod", registry);

  // The first `produce` links — but the injected correlation throws. It must be swallowed (advisory),
  // so the frame handler does not throw and the stream is left UNLINKED so a later produce retries.
  failLink(true);
  hub.handler?.(produce(jobStream("kL"), 1, "x"), p.conn);
  assertEquals(inner.count(), 0, "a throwing link is swallowed and records no correlation");

  // A later produce (link now succeeds) retries the link — proving the stream was left unlinked.
  failLink(false);
  hub.handler?.(produce(jobStream("kL"), 1, "y"), p.conn);
  assertEquals(inner.jobKeysFor("worker-L"), ["kL"], "the link retries and succeeds on a later frame");
  assertEquals(inner.count(), 1);
  service.teardown();
});

test("H6 correlation write-side: a throwing correlation.releaseJob() never escapes the frame handler; completion still finalizes", () => {
  const registry = new ConnectionRegistry();
  const inner = new CorrelationRegistry();
  const { correlation, failRelease } = throwingCorrelation(inner);
  const byConnection = new Map([["prod", "worker-X"]]);
  const hub = capturingHub();
  const service = new RelayTranscriptService({
    hub,
    registry,
    db: undefined,
    log: noopLog(),
    correlation: () => correlation,
    instanceForConnection: (id) => byConnection.get(id),
  });
  const p = connect("prod", registry);
  hub.handler?.(produce(jobStream("kX"), 1, "x"), p.conn);
  assertEquals(inner.jobKeysFor("worker-X"), ["kX"]);

  // A producer disconnect drives #reconcile → #unlink, but releaseJob throws. The advisory contract
  // is "never throws into the frame handler": the throw must be swallowed so the reconcile pass (and
  // the completion it drives) do not bubble out and take down unrelated streams' relay processing.
  failRelease(true);
  registry.remove("prod");
  const other = connect("cons", registry);
  hub.handler?.(grant(0), other.conn); // must NOT throw despite releaseJob throwing

  // The stream still finalizes (terminal) so #reconcile does not thrash it every frame, and a later
  // frame's reconcile is a clean no-op rather than a repeated crash.
  hub.handler?.(produce(jobStream("kX"), 2, "late"), p.conn);
  assertEquals(
    inner.jobKeysFor("worker-X"),
    ["kX"],
    "a swallowed release leaves the correlation held (linked), never a crash",
  );
  service.teardown();
});

test("H6 correlation write-side: a producer disconnect releases its job correlation even unpersisted", () => {
  const registry = new ConnectionRegistry();
  const correlation = new CorrelationRegistry();
  const byConnection = new Map([["prod", "worker-B"]]);
  // No DataLayer → the relay runs unpersisted; correlation release must still fire (store-independent).
  const { service, hub } = mkCorrelatedService(registry, undefined, correlation, byConnection);
  const p = connect("prod", registry);
  hub.handler?.(produce(jobStream("k2"), 1, "x"), p.conn);
  assertEquals(correlation.jobKeysFor("worker-B"), ["k2"]);

  // Producer drops; a subsequent frame from any live connection reconciles the dead producer.
  registry.remove("prod");
  const other = connect("cons", registry);
  hub.handler?.(grant(0), other.conn);
  assertEquals(correlation.jobKeysFor("worker-B"), [], "disconnect releases the job");
  assertEquals(correlation.count(), 0);
  service.teardown();
});

test("H6 correlation write-side: non-job streams are never linked; a link retries until the instance resolves", () => {
  const registry = new ConnectionRegistry();
  const correlation = new CorrelationRegistry();
  const byConnection = new Map<string, string>();
  const { service, hub } = mkCorrelatedService(registry, memoryDb(), correlation, byConnection);
  const p = connect("prod", registry);

  // A plain (non-`job:`) stream carries no jobKey → never correlated.
  hub.handler?.(produce("plain-stream", 1, "x"), p.conn);
  assertEquals(correlation.count(), 0, "non-job streams are not linked");

  // A job stream whose producer's presence instance is not yet known does not link — but a later
  // frame (after the register lands) retries and links, closing the register/produce race.
  hub.handler?.(produce(jobStream("k3"), 1, "a"), p.conn);
  assertEquals(correlation.count(), 0, "no presence instance yet → not linked");
  byConnection.set("prod", "worker-C");
  hub.handler?.(produce(jobStream("k3"), 1, "b"), p.conn);
  assertEquals(correlation.jobKeysFor("worker-C"), ["k3"], "retried link succeeds once the instance resolves");
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

test("mount runs an eager retention sweep so a transcript already past retention from a previous run is retired on boot (#222)", () => {
  const registry = new ConnectionRegistry();
  // One durable db shared across two mounts models a process restart: the transcript table survives,
  // so a completed-ephemeral transcript persisted before downtime is still present at the next boot.
  const db = memoryDb();
  let nowMs = 1_000_000;
  const mkCtx = () => ({
    hub: capturingHub() as never,
    registry: registry as never,
    transport: undefined as never,
    data: { source: () => ({ db }) } as never,
    log: noopLog(),
  });

  // First run: persist a completed-ephemeral transcript, then simulate downtime past its retention window.
  const first = createRelayFamily({ transcript: { ephemeralRetentionMs: 10, clock: { now: () => nowMs } } });
  first.mount(mkCtx());
  const s1 = currentRelayTranscriptService();
  assert(s1 !== undefined);
  s1.store?.flush("job:stale", { since: () => ({ entries: [{ offset: 0, chunk: "x" }] }), nextOffset: 1 }, "ephemeral");
  assertEquals(s1.transcriptOf("job:stale")?.status, "completed");
  first.teardown?.();
  nowMs += 1000; // downtime elapses well past the 10ms retention window

  // Second run (restart) over the SAME durable db: the eager mount sweep must retire the already-expired
  // transcript immediately — without waiting for the first periodic tick and without an explicit sweep().
  const second = createRelayFamily({ transcript: { ephemeralRetentionMs: 10, clock: { now: () => nowMs } } });
  second.mount(mkCtx());
  const s2 = currentRelayTranscriptService();
  assert(s2 !== undefined);
  assertEquals(
    s2.transcriptOf("job:stale"),
    undefined,
    "the eager mount sweep retires a transcript already past retention from a previous run",
  );
  second.teardown?.();
});

test("sweep cadence: a fraction of the retention window, floored at 1ms and capped at the Node timer max", () => {
  // A normal retention window derives a quarter-window cadence.
  assertEquals(sweepIntervalMs(1000), 250);
  // A tiny/zero window still floors at a live 1ms tick rather than 0.
  assertEquals(sweepIntervalMs(1), 1);
  assertEquals(sweepIntervalMs(0), 1);
  // A very large window (~1 year) would derive a >2^31-1 interval; Node clamps such a delay to 1ms and
  // busy-loops. Cap it at the 32-bit timer ceiling so the periodic sweep stays a slow tick.
  const oneYearMs = 365 * 24 * 60 * 60 * 1000;
  assert(Math.floor(oneYearMs / 4) > 2_147_483_647, "precondition: an unclamped year/4 overflows the timer");
  assertEquals(sweepIntervalMs(oneYearMs), 2_147_483_647);
  // A non-finite retention config (NaN, ±Infinity) derives a NaN interval that setInterval() coerces
  // to a 1ms busy tick. Clamp any non-finite window to the same timer ceiling the overflow case uses,
  // so a broken config degrades to the slowest safe sweep rather than a busy loop.
  assertEquals(sweepIntervalMs(Number.NaN), 2_147_483_647);
  assertEquals(sweepIntervalMs(Number.POSITIVE_INFINITY), 2_147_483_647);
  assertEquals(sweepIntervalMs(Number.NEGATIVE_INFINITY), 2_147_483_647);
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
