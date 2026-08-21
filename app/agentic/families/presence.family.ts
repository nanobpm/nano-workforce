// nano-workforce — the agentic presence & registry family (ADR 0056, H1 / #144).
//
// A pluggable {@link AgenticFamily} that plugs into the H0 seam (`app/agentic/registry.ts`) with NO
// edit to `main.ts`, `drainAndExit`, or any shared boot line — the loader discovers this file by its
// `*.family.ts` suffix and the seam mounts it. It owns the channel's `register` / `heartbeat` /
// `deregister` message families (attached through the hub's `registerFamilyHandler` seam, never a
// shared dispatch switch) and layers a DURABLE supply registry over the app's SQLite DataLayer — the
// same store the advisory blackboard uses; no separate database.
//
// What it gives the fleet:
//   - REGISTER      → a durable presence row (instance + declared capability + connection + liveness).
//   - HEARTBEAT     → refreshes the row's `last_seen` so a live worker stays visible.
//   - DEREGISTER / disconnect / TTL timeout → removes the row (see the maintenance tick below).
//   - {@link PresenceRegistry.snapshot} → the read-only SUPPLY mirror: connected workers grouped by
//     leaf token, each with identity, family, host, liveness (and a seam for current jobKeys). This
//     is the supply feed the enrolment epic (#152) reads and the cockpit (H5) renders.
//
// Invariants (ADR 0056): app-tier only, never the engine; the Camunda-8 job protocol (worker⇄engine)
// is untouched — presence rides the agentic channel only; ADVISORY — the registry is a read-only
// mirror and NEVER hard-locks or gates a BPMN sequence flow. Capability (cognition/weight/family/host)
// is an ENROLMENT attribute, never a routing token.
import {
  attachPresenceFamily,
  type PresenceFamilyHandle,
  PresenceStore,
  type PresenceStoreOptions,
  type SqliteDb,
} from "@nanobpm/agentic/presence";
import type { DataLayer } from "@nanobpm/urban";
import type { AgenticContext, AgenticFamily } from "../registry.ts";

/** The message-family name this module owns (its three handlers are register/heartbeat/deregister). */
export const PRESENCE_FAMILY = "presence";

/** The maintenance tick runs at a third of the presence TTL — matching the hub/store sweep cadence. */
const SWEEP_DIVISOR = 3;

/** One worker in the supply mirror: a durable presence row projected for the cockpit/enrolment feed. */
export interface SupplyWorker {
  /** The worker instance id (`register.instance`). */
  readonly instance: string;
  /** The authenticated ADR 0028 principal — the leaf token this worker registered under. */
  readonly identity: string;
  /** Declared cognition (enrolment attribute), if any. */
  readonly cognition?: string;
  /** Declared cognition weight (enrolment attribute), if any. */
  readonly weight?: number;
  /** Declared family (enrolment attribute) — the diversity-SLO seat filler, if any. */
  readonly family?: string;
  /** Declared host (enrolment attribute) — where the worker runs, if any. */
  readonly host?: string;
  /** The channel connection the worker last registered on. */
  readonly connectionId: string;
  /** When the worker first registered, ISO-8601. */
  readonly registeredAt: string;
  /** Last liveness refresh (register/heartbeat), epoch ms. */
  readonly lastSeen: number;
  /** Whether the worker's connection is still open in the hub's live connection registry. */
  readonly live: boolean;
  /** How long since the last liveness refresh, in ms (0 when fresh). */
  readonly staleMs: number;
  /**
   * The jobKeys this worker is currently processing. Presence carries no job attribution of its own,
   * so this is populated from the injected {@link SnapshotOptions.jobKeysFor} resolver — the seam the
   * relay/correlation slice (H6) wires; it is `[]` until then.
   */
  readonly jobKeys: readonly string[];
}

/** The supply for one leaf token: the workers registered under it. */
export interface SupplyLeaf {
  /** The leaf token — the ADR 0028 identity principal. (Refined to SERVE tokens when vocab #152 lands.) */
  readonly token: string;
  /** The workers registered under this leaf token, sorted by instance. */
  readonly workers: readonly SupplyWorker[];
}

/** The read-only supply snapshot: the live registry grouped by leaf token, plus a flat worker list. */
export interface PresenceSnapshot {
  /** Supply grouped by leaf token, sorted by token. */
  readonly leaves: readonly SupplyLeaf[];
  /** Every registered worker, flat, sorted by instance. */
  readonly workers: readonly SupplyWorker[];
  /** The number of registered workers. */
  readonly count: number;
}

/** The canonical supply-row shape the enrolment epic (#152) resolves against the vocab. */
export interface RegisteredWorker {
  readonly instance: string;
  readonly capability: {
    readonly cognition?: string;
    readonly weight?: number;
    readonly family?: string;
    readonly host?: string;
  };
}

/** Options for {@link PresenceRegistry.snapshot}. */
export interface SnapshotOptions {
  /** "Now" in epoch ms for the `staleMs` computation. Defaults to `Date.now()`. */
  readonly now?: number;
  /** Resolve the current jobKeys for a worker instance. Defaults to none (presence has no jobs). */
  readonly jobKeysFor?: (instance: string) => readonly string[];
}

/**
 * The durable presence registry: a read-only projection over the {@link PresenceStore}, cross-checked
 * against the set of currently-open hub connections for liveness. It NEVER gates control flow — it is
 * the supply mirror the enrolment epic and the cockpit read.
 */
export class PresenceRegistry {
  readonly #store: PresenceStore;
  readonly #liveConnectionIds: () => Set<string>;

  constructor(store: PresenceStore, liveConnectionIds: () => Set<string>) {
    this.#store = store;
    this.#liveConnectionIds = liveConnectionIds;
  }

  /** The presence liveness TTL in ms. */
  get ttlMs(): number {
    return this.#store.ttlMs;
  }

  /** The number of registered workers. */
  count(): number {
    return this.#store.count();
  }

  /** The canonical supply rows (`{ instance, capability }`) the enrolment epic (#152) consumes. */
  registeredWorkers(): RegisteredWorker[] {
    return this.#store.list().map((row) => ({ instance: row.instance, capability: { ...row.capability } }));
  }

  /**
   * The worker instance registered on a given connection, or undefined when none is. This is the
   * connection → instance resolver the relay/correlation slice (H6, #149) uses to attribute a
   * `produce` frame for a `job:<jobKey>` stream to the presence instance owning the producing
   * connection — the one fact the relay holds (the connection id) turned into the join key the
   * correlation registry needs. An empty connection id (or an unknown one) resolves to undefined.
   */
  instanceForConnection(connectionId: string): string | undefined {
    if (connectionId === "") return undefined;
    for (const row of this.#store.list()) {
      if (row.connectionId === connectionId) return row.instance;
    }
    return undefined;
  }

  /**
   * Eagerly drop presence rows whose connection the hub has already closed (a disconnect the hub's
   * single close listener removed from its in-memory registry). Rows also age out on the presence
   * TTL via {@link PresenceStore.sweep}; this is the eager disconnect path. Returns the removed
   * instance ids.
   */
  reconcile(): string[] {
    const live = this.#liveConnectionIds();
    const deadConnections = new Set<string>();
    for (const row of this.#store.list()) {
      if (!live.has(row.connectionId)) deadConnections.add(row.connectionId);
    }
    const removed: string[] = [];
    for (const connectionId of deadConnections) {
      removed.push(...this.#store.removeByConnection(connectionId));
    }
    return removed;
  }

  /** The read-only supply snapshot: connected workers grouped by leaf token, with family/host/liveness. */
  snapshot(options: SnapshotOptions = {}): PresenceSnapshot {
    const now = options.now ?? Date.now();
    const jobKeysFor = options.jobKeysFor ?? (() => []);
    const live = this.#liveConnectionIds();
    const workers: SupplyWorker[] = this.#store.list().map((row) => ({
      instance: row.instance,
      identity: row.identity,
      cognition: row.capability.cognition,
      weight: row.capability.weight,
      family: row.capability.family,
      host: row.capability.host,
      connectionId: row.connectionId,
      registeredAt: row.registeredAt,
      lastSeen: row.lastSeen,
      live: live.has(row.connectionId),
      staleMs: Math.max(0, now - row.lastSeen),
      jobKeys: [...jobKeysFor(row.instance)],
    }));

    const byToken = new Map<string, SupplyWorker[]>();
    for (const worker of workers) {
      const bucket = byToken.get(worker.identity);
      if (bucket) bucket.push(worker);
      else byToken.set(worker.identity, [worker]);
    }
    const byInstance = (a: SupplyWorker, b: SupplyWorker) => a.instance.localeCompare(b.instance);
    const leaves: SupplyLeaf[] = [...byToken.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([token, ws]) => ({ token, workers: ws.slice().sort(byInstance) }));

    return { leaves, workers: workers.slice().sort(byInstance), count: workers.length };
  }
}

/** Open the app's synchronous SQLite handle from the DataLayer, or undefined when data isn't mounted. */
export function openPresenceDb(data: DataLayer | undefined): SqliteDb | undefined {
  if (!data) return undefined;
  return data.source().db;
}

/** The live registry from the most recent mount, so the cockpit/report (H5) can read the supply feed. */
let currentRegistry: PresenceRegistry | undefined;

/** The mounted presence registry (the supply feed), or undefined before mount / after teardown. */
export function currentPresenceRegistry(): PresenceRegistry | undefined {
  return currentRegistry;
}

interface MountState {
  readonly registry: PresenceRegistry;
  readonly handle: PresenceFamilyHandle;
  readonly timer: ReturnType<typeof setInterval> | undefined;
}

let state: MountState | undefined;

/** Build the presence store; exported so tests can inject a fake clock / TTL over an in-memory db. */
export function createPresenceStore(db: SqliteDb, options?: PresenceStoreOptions): PresenceStore {
  return new PresenceStore(db, options);
}

/**
 * The presence family module. `mount` attaches register/heartbeat/deregister to the hub, applies the
 * schema, and starts ONE canonical maintenance tick that both ages out on the presence TTL and drops
 * rows for disconnected connections. `teardown` stops the tick and the presence sweep.
 */
export const family: AgenticFamily = {
  name: PRESENCE_FAMILY,

  mount(ctx: AgenticContext): void {
    const db = openPresenceDb(ctx.data);
    if (!db) {
      ctx.log.warn("agentic presence: no data layer mounted — presence registry disabled");
      return;
    }
    const store = createPresenceStore(db);
    store.ensureSchema();

    const liveConnectionIds = () => new Set(ctx.hub.registry.list().map((conn) => conn.id));
    const registry = new PresenceRegistry(store, liveConnectionIds);

    // Attach the three presence handlers via the S1 seam. Disable the package's own TTL timer
    // (`sweepIntervalMs: 0`) so this module runs a SINGLE maintenance loop rather than two — the
    // canonical presence-maintenance pass, not a second poller (derivation over duplication).
    const handle = attachPresenceFamily(ctx.hub, store, {
      sweepIntervalMs: 0,
      onError: (err, connectionId) =>
        ctx.log.warn("agentic presence fault", { connectionId, err: String(err) }),
    });

    const interval = Math.max(1, Math.floor(store.ttlMs / SWEEP_DIVISOR));
    const tick = () => {
      // TTL age-out (silent-worker liveness timeout) + eager disconnect cleanup, on one cadence.
      handle.sweepNow();
      try {
        registry.reconcile();
      } catch (err) {
        ctx.log.warn("agentic presence reconcile failed", { err: String(err) });
      }
    };
    // Run one maintenance pass eagerly at mount so the registry is correct immediately: the
    // presence table is durable across restarts, so without this first sweep/reconcile
    // `registeredWorkers()` / `snapshot()` could briefly surface stale rows from a previous run
    // (all connections start closed) until the first interval tick fires.
    tick();
    const timer = interval > 0 ? setInterval(tick, interval) : undefined;
    // Never keep the process alive for the presence sweep alone.
    timer?.unref?.();

    state = { registry, handle, timer };
    currentRegistry = registry;
    ctx.log.info("agentic presence mounted", { family: PRESENCE_FAMILY, ttlMs: store.ttlMs });
  },

  teardown(): void {
    if (!state) return;
    if (state.timer !== undefined) clearInterval(state.timer);
    state.handle.stop();
    state = undefined;
    currentRegistry = undefined;
  },
};

export default family;
