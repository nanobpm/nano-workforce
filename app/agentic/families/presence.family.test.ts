// Unit tests for the agentic presence & registry family (ADR 0056, H1 / #144).
//
// Two layers:
//   1. PresenceRegistry over an in-memory SQLite DataLayer — snapshot grouping, liveness, the
//      jobKeys seam, the canonical supply rows, reconcile, and the register/heartbeat/deregister/
//      TTL lifecycle.
//   2. The `family` module end-to-end against a REAL AgenticHub driven by an in-memory transport:
//      a REGISTER frame creates a durable row; HEARTBEAT keeps it; DEREGISTER and disconnect remove
//      it; teardown stops cleanly; a mount with no DataLayer is a safe no-op.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AgenticHub } from "@nanobpm/agentic/channel";
import type {
  Authenticator,
  ChannelConnection,
  ChannelTransport,
} from "@nanobpm/agentic/channel";
import { encodeFrame, type Frame, type MessageFamily } from "@nanobpm/agentic/protocol";
import type { SqliteDb } from "@nanobpm/agentic/presence";
import type { DataLayer } from "@nanobpm/urban";
import { assert, assertEquals } from "#test-assert";
import { noopLog } from "../../../test/log.ts";
import type { AgenticContext } from "../registry.ts";
import {
  createPresenceStore,
  currentPresenceRegistry,
  family,
  openPresenceDb,
  PresenceRegistry,
} from "./presence.family.ts";

// ── in-memory SQLite (the app's synchronous SqliteDb shape) ────────────────────────────────────

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

/** A DataLayer whose default source exposes the given synchronous SqliteDb (nothing else is used). */
function memData(db: SqliteDb): DataLayer {
  return { source: () => ({ db }) } as unknown as DataLayer;
}

/** A mutable fake clock so TTL sweeps are deterministic. */
function fakeClock(start = 1_000): { now(): number; advance(ms: number): void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// ── PresenceRegistry over an in-memory DataLayer ───────────────────────────────────────────────

test("snapshot: groups registered workers by leaf token with family/host", () => {
  const store = createPresenceStore(memSqlite());
  store.ensureSchema();
  // Two workers under leaf token "leafA", one under "leafB".
  store.register({ instance: "w2", connectionId: "c2", identity: "leafA", capability: { family: "kimi", host: "boxA2" } });
  store.register({ instance: "w1", connectionId: "c1", identity: "leafA", capability: { family: "opus", host: "boxA1" } });
  store.register({ instance: "w3", connectionId: "c3", identity: "leafB", capability: { family: "qwen", host: "boxB" } });

  const registry = new PresenceRegistry(store, () => new Set(["c1", "c2", "c3"]));
  const snap = registry.snapshot({ now: 2_000 });

  assertEquals(snap.count, 3);
  assertEquals(snap.leaves.map((l) => l.token), ["leafA", "leafB"], "leaves sorted by token");
  const leafA = snap.leaves[0];
  assertEquals(leafA.workers.map((w) => w.instance), ["w1", "w2"], "workers sorted by instance");
  assertEquals(leafA.workers[0].family, "opus");
  assertEquals(leafA.workers[0].host, "boxA1");
  assertEquals(snap.leaves[1].workers[0].family, "qwen");
  assertEquals(snap.workers.map((w) => w.instance), ["w1", "w2", "w3"], "flat list sorted");
});

test("snapshot: liveness reflects the open-connection set", () => {
  const store = createPresenceStore(memSqlite());
  store.ensureSchema();
  store.register({ instance: "live", connectionId: "cLive", identity: "leaf", capability: {} });
  store.register({ instance: "gone", connectionId: "cGone", identity: "leaf", capability: {} });

  const registry = new PresenceRegistry(store, () => new Set(["cLive"]));
  const byInstance = new Map(registry.snapshot().workers.map((w) => [w.instance, w]));
  assertEquals(byInstance.get("live")?.live, true);
  assertEquals(byInstance.get("gone")?.live, false);
});

test("snapshot: staleMs is measured from lastSeen and jobKeysFor seeds current jobKeys", () => {
  const clock = fakeClock(5_000);
  const store = createPresenceStore(memSqlite(), { clock });
  store.ensureSchema();
  store.register({ instance: "w1", connectionId: "c1", identity: "leaf", capability: {} });

  const registry = new PresenceRegistry(store, () => new Set(["c1"]));
  const snap = registry.snapshot({
    now: 5_250,
    jobKeysFor: (instance) => (instance === "w1" ? ["job-42", "job-43"] : []),
  });
  assertEquals(snap.workers[0].staleMs, 250);
  assertEquals(snap.workers[0].jobKeys, ["job-42", "job-43"]);
});

test("snapshot: jobKeys default to none (presence carries no job attribution)", () => {
  const store = createPresenceStore(memSqlite());
  store.ensureSchema();
  store.register({ instance: "w1", connectionId: "c1", identity: "leaf", capability: {} });
  const registry = new PresenceRegistry(store, () => new Set(["c1"]));
  assertEquals(registry.snapshot().workers[0].jobKeys, []);
});

test("registeredWorkers: returns the canonical {instance, capability} supply rows", () => {
  const store = createPresenceStore(memSqlite());
  store.ensureSchema();
  store.register({ instance: "w1", connectionId: "c1", identity: "leaf", capability: { family: "opus", weight: 4.8, cognition: "deep" } });
  const registry = new PresenceRegistry(store, () => new Set(["c1"]));
  assertEquals(registry.registeredWorkers(), [
    { instance: "w1", capability: { cognition: "deep", weight: 4.8, family: "opus" } },
  ]);
});

test("instanceForConnection: resolves the worker instance owning a connection (H6 write-side seam)", () => {
  const store = createPresenceStore(memSqlite());
  store.ensureSchema();
  store.register({ instance: "w1", connectionId: "c1", identity: "leaf", capability: {} });
  store.register({ instance: "w2", connectionId: "c2", identity: "leaf", capability: {} });
  const registry = new PresenceRegistry(store, () => new Set(["c1", "c2"]));
  assertEquals(registry.instanceForConnection("c1"), "w1");
  assertEquals(registry.instanceForConnection("c2"), "w2");
  assertEquals(registry.instanceForConnection("nope"), undefined, "unknown connection → undefined");
  assertEquals(registry.instanceForConnection(""), undefined, "empty connection → undefined");
});

test("isInstanceLive: an instance is live while ANY of its connections is open — survives a reconnect (#689)", () => {
  const store = createPresenceStore(memSqlite());
  store.ensureSchema();
  // worker-L reconnected: its OLD connection (cOld) is closed, a NEW one (cNew) is open. Presence is
  // keyed by instance, so both rows exist; only cNew is live.
  store.register({ instance: "worker-L", connectionId: "cOld", identity: "leaf", capability: {} });
  store.register({ instance: "worker-L", connectionId: "cNew", identity: "leaf", capability: {} });
  store.register({ instance: "worker-Gone", connectionId: "cGone", identity: "leaf", capability: {} });
  const registry = new PresenceRegistry(store, () => new Set(["cNew"]));

  assertEquals(registry.isInstanceLive("worker-L"), true, "live via its new connection despite the old one dropping");
  assertEquals(registry.isInstanceLive("worker-Gone"), false, "no live connection → not live");
  assertEquals(registry.isInstanceLive("unknown"), false, "unknown instance → not live");
  assertEquals(registry.isInstanceLive(""), false, "empty instance → not live");
});

test("attributionOf: resolves a worker instance's durable identity + host for job attribution (#485)", () => {
  const store = createPresenceStore(memSqlite());
  store.ensureSchema();
  store.register({ instance: "w1", connectionId: "c1", identity: "leafA", capability: { host: "boxA1" } });
  store.register({ instance: "w2", connectionId: "c2", identity: "leafB", capability: {} });
  const registry = new PresenceRegistry(store, () => new Set(["c1", "c2"]));
  assertEquals(registry.attributionOf("w1"), { identity: "leafA", host: "boxA1" });
  assertEquals(registry.attributionOf("w2"), { identity: "leafB", host: undefined }, "no host → host undefined");
  assertEquals(registry.attributionOf("nope"), undefined, "unknown instance → undefined");
  assertEquals(registry.attributionOf(""), undefined, "empty instance → undefined");
});

test("reconcile: removes rows whose connection the hub has closed, keeps live ones", () => {
  const store = createPresenceStore(memSqlite());
  store.ensureSchema();
  store.register({ instance: "keep", connectionId: "cLive", identity: "leaf", capability: {} });
  store.register({ instance: "drop", connectionId: "cGone", identity: "leaf", capability: {} });

  const registry = new PresenceRegistry(store, () => new Set(["cLive"]));
  const removed = registry.reconcile();
  assertEquals(removed, ["drop"]);
  assertEquals(registry.count(), 1);
  assertEquals(registry.snapshot().workers.map((w) => w.instance), ["keep"]);
});

test("lifecycle: register creates, heartbeat keeps live, deregister removes, TTL sweep ages out", () => {
  const clock = fakeClock(0);
  const store = createPresenceStore(memSqlite(), { ttlMs: 1_000, clock });
  store.ensureSchema();
  const registry = new PresenceRegistry(store, () => new Set(["c1", "c2"]));

  store.register({ instance: "w1", connectionId: "c1", identity: "leaf", capability: {} });
  assertEquals(registry.count(), 1);

  // A heartbeat just before the TTL keeps the worker alive across the sweep.
  clock.advance(900);
  assert(store.heartbeat("w1", "leaf"), "heartbeat refreshes a registered instance");
  clock.advance(900);
  assertEquals(store.sweep().length, 0, "not stale — heartbeat kept it live");
  assertEquals(registry.count(), 1);

  // Without a further heartbeat it ages out past the TTL.
  clock.advance(1_500);
  assertEquals(store.sweep().map((r) => r.instance), ["w1"]);
  assertEquals(registry.count(), 0);

  // A graceful deregister removes a re-registered instance immediately.
  store.register({ instance: "w2", connectionId: "c2", identity: "leaf", capability: {} });
  assert(store.deregister("w2", "leaf"));
  assertEquals(registry.count(), 0);
});

test("migration 023 provisions the exact table the store reads/writes", () => {
  const db = memSqlite();
  const sql = readFileSync(
    join(fileURLToPath(new URL("../../../db/migrations/023_agentic_presence.sql", import.meta.url))),
    "utf8",
  );
  db.exec(sql);
  // A store that does NOT call ensureSchema still works against the migrated table.
  const store = createPresenceStore(db);
  store.register({ instance: "w1", connectionId: "c1", identity: "leaf", capability: { family: "opus", host: "box" } });
  assertEquals(store.get("w1")?.capability.host, "box");
});

test("openPresenceDb: returns undefined when no DataLayer is mounted", () => {
  assertEquals(openPresenceDb(undefined), undefined);
});

// ── family module against a real hub + in-memory transport ─────────────────────────────────────

interface FakeConn {
  readonly conn: ChannelConnection;
  feed(frame: Frame): void;
  disconnect(): void;
}

function fakeConn(id: string, identity: string): FakeConn {
  let onMessage: ((bytes: Uint8Array) => void) | undefined;
  let onClose: ((code?: number, reason?: string) => void) | undefined;
  const conn: ChannelConnection = {
    id,
    handshake: { query: { identity }, token: "t", credential: "c" },
    send: () => {},
    close: (code, reason) => onClose?.(code, reason),
    onMessage: (l) => { onMessage = l; },
    onClose: (l) => { onClose = l; },
  };
  return {
    conn,
    feed: (frame) => onMessage?.(encodeFrame(frame)),
    disconnect: () => onClose?.(),
  };
}

function memTransport(): { transport: ChannelTransport; connect(conn: ChannelConnection): void } {
  let onConnection: ((conn: ChannelConnection) => void) | undefined;
  const transport: ChannelTransport = {
    onConnection: (l) => { onConnection = l; },
    address: { port: 0 },
    close: async () => {},
  };
  return { transport, connect: (conn) => onConnection?.(conn) };
}

/** Authenticate every peer, deriving its identity (the leaf token) from the handshake query. */
const authenticator: Authenticator = (req) => ({
  ok: true,
  grant: { identity: req.query?.identity ?? "anon" },
});

/** Flush the hub's microtasks (async auth + async frame routing) so assertions see the result. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function registerFrame(instance: string, capability: Record<string, unknown>): Frame {
  return { lane: "control", family: "register", seq: 1, payload: { instance, capability } };
}
function familyFrame(fam: MessageFamily, instance: string): Frame {
  return { lane: "control", family: fam, seq: 1, payload: { instance } };
}

async function mountFamily(db: SqliteDb | undefined): Promise<{ hub: AgenticHub; transport: ReturnType<typeof memTransport> }> {
  const transport = memTransport();
  const hub = new AgenticHub({ transport: transport.transport, authenticator, sweepIntervalMs: 0 });
  const ctx: AgenticContext = {
    hub,
    registry: hub.registry,
    // The transport handle is not exercised by the presence family; the in-memory one stands in.
    transport: transport.transport as never,
    data: db ? memData(db) : undefined,
    log: noopLog(),
  };
  await family.mount(ctx);
  return { hub, transport };
}

test("family: mount attaches the three handlers and a REGISTER creates a durable presence row", async () => {
  const { hub, transport } = await mountFamily(memSqlite());
  try {
    assertEquals(hub.router.families().sort(), ["deregister", "heartbeat", "register"]);

    const peer = fakeConn("c1", "leafA");
    transport.connect(peer.conn);
    await flush();
    peer.feed(registerFrame("w1", { family: "opus", host: "boxA" }));
    await flush();

    const snap = currentPresenceRegistry()?.snapshot();
    assert(snap, "registry is mounted");
    assertEquals(snap.count, 1);
    assertEquals(snap.leaves[0].token, "leafA");
    assertEquals(snap.leaves[0].workers[0].family, "opus");
    assertEquals(snap.leaves[0].workers[0].host, "boxA");
    assertEquals(snap.leaves[0].workers[0].live, true, "connection is open");
  } finally {
    family.teardown?.();
    await hub.close();
  }
});

test("family: HEARTBEAT keeps a worker and DEREGISTER removes it", async () => {
  const { hub, transport } = await mountFamily(memSqlite());
  try {
    const peer = fakeConn("c1", "leaf");
    transport.connect(peer.conn);
    await flush();
    peer.feed(registerFrame("w1", {}));
    await flush();
    assertEquals(currentPresenceRegistry()?.count(), 1);

    peer.feed(familyFrame("heartbeat", "w1"));
    await flush();
    assertEquals(currentPresenceRegistry()?.count(), 1, "heartbeat keeps the row");

    peer.feed(familyFrame("deregister", "w1"));
    await flush();
    assertEquals(currentPresenceRegistry()?.count(), 0, "deregister removes the row");
  } finally {
    family.teardown?.();
    await hub.close();
  }
});

test("family: a disconnect removes the worker via reconcile", async () => {
  const { hub, transport } = await mountFamily(memSqlite());
  try {
    const peer = fakeConn("c1", "leaf");
    transport.connect(peer.conn);
    await flush();
    peer.feed(registerFrame("w1", {}));
    await flush();
    assertEquals(currentPresenceRegistry()?.count(), 1);

    // Simulate the peer vanishing: the hub's own close listener drops it from the live registry.
    peer.disconnect();
    assertEquals(hub.connectionCount, 0, "hub no longer tracks the connection");

    const removed = currentPresenceRegistry()?.reconcile();
    assertEquals(removed, ["w1"]);
    assertEquals(currentPresenceRegistry()?.count(), 0);
  } finally {
    family.teardown?.();
    await hub.close();
  }
});

test("family: teardown stops the family and clears the current registry", async () => {
  const { hub } = await mountFamily(memSqlite());
  assert(currentPresenceRegistry(), "mounted");
  family.teardown?.();
  assertEquals(currentPresenceRegistry(), undefined, "cleared on teardown");
  await hub.close();
});

test("family: mounting without a DataLayer is a safe no-op", async () => {
  const { hub } = await mountFamily(undefined);
  try {
    assertEquals(currentPresenceRegistry(), undefined, "no registry without data");
    // The three presence handlers are not attached when there is nothing to persist to.
    assertEquals(hub.router.families(), []);
  } finally {
    family.teardown?.();
    await hub.close();
  }
});
