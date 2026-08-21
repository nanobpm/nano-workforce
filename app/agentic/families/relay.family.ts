// nano-workforce — the relay ring + transcript store agentic family (ADR 0056, H3 / #146).
//
// This is a sibling slice of the agentic-visibility epic (#142). It plugs into the H0 (#143)
// family-registration SEAM (`../registry.ts`) as ONE NEW FILE and NOTHING ELSE — it never edits
// `main.ts`, `drainAndExit`, or any shared boot line. The auto-discovery loader (`../loader.ts`)
// finds it by the `*.family.ts` suffix and the seam mounts + tears it down.
//
// It composes two published primitives — it re-implements NEITHER:
//   - `@nanobpm/agentic/relay`      — the bounded replay ring, three-lane QoS scheduler
//     (control > interactive > bulk), resume-from-offset, and incarnation/generation fencing,
//     all inside {@link RelayHub}. We mount it on the hub's `registerFamilyHandler` seam.
//   - `@nanobpm/agentic/transcript` — {@link TranscriptStore}, retention-by-lifecycle over the app's
//     SQLite DataLayer. Ephemeral streams flush the ring to a durable transcript on job completion;
//     long-lived streams retain chunks so a reconnecting consumer resumes-from-offset (reattach).
//
// Its DB schema ships as the reserved forward-only additive migration
// `db/migrations/024_agentic_transcript.sql` (H0 pre-allocated prefix 024 for H3), a byte-for-byte
// mirror of the package's canonical `TRANSCRIPT_SCHEMA_SQL`, drift-guarded by this slice's test.
//
// Invariants (ADR 0056): app-tier only, never the engine; the Camunda-8 job protocol (worker⇄engine)
// is untouched — the agentic channel is the only new conversation; advisory semantics preserved (the
// relay/transcript never hard-lock or gate a BPMN sequence flow).
import type { ConnectionRegistry } from "@nanobpm/agentic/channel";
import type { Frame } from "@nanobpm/agentic/protocol";
import { RELAY_FAMILY, RelayHub, type RelayHubOptions } from "@nanobpm/agentic/relay";
import {
  type SqliteDb,
  type TranscriptLifecycle,
  type TranscriptRing,
  type TranscriptSlice,
  TranscriptStore,
  type TranscriptStoreOptions,
  type TranscriptStream,
} from "@nanobpm/agentic/transcript";
import type { Logger } from "@nanobpm/urban";
import { currentCorrelation, type JobContext, jobKeyOfStream } from "../correlation.ts";
import type { AgenticContext, AgenticFamily } from "../registry.ts";
import { currentPresenceRegistry } from "./presence.family.ts";

/** The stable family name this slice registers under the seam (distinct from the wire family key). */
export const RELAY_FAMILY_NAME = "relay";

/** The default retention-sweep cadence divisor: the periodic sweep runs at a fraction of the retention
 * window (like the presence family runs its maintenance tick at a fraction of the presence TTL). */
const SWEEP_DIVISOR = 4;

/** Node's setInterval/setTimeout ceiling (2^31-1 ms ≈ 24.8 days). A delay above this overflows the
 * 32-bit timer and Node silently clamps it to 1ms — turning a slow periodic tick into a busy loop. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The retention-sweep cadence (ms) for a given ephemeral-retention window: a fraction of the window,
 * floored at 1ms and — crucially — capped at {@link MAX_TIMER_MS} so a large retention config (e.g.
 * a multi-month window) cannot overflow Node's 32-bit timer and degrade the sweep into a busy loop.
 * A non-finite window (NaN / ±Infinity — a broken config) derives a non-finite interval that
 * setInterval() would coerce to a 1ms busy tick; clamp it to the same {@link MAX_TIMER_MS} ceiling so
 * a garbage config degrades to the slowest safe sweep rather than pegging the sweep loop.
 */
export function sweepIntervalMs(ephemeralRetentionMs: number): number {
  if (!Number.isFinite(ephemeralRetentionMs)) return MAX_TIMER_MS;
  const interval = Math.floor(ephemeralRetentionMs / SWEEP_DIVISOR);
  return Math.min(MAX_TIMER_MS, Math.max(1, interval));
}

/** Read a property off an unknown value without an unsafe `as` cast (mirrors the loader's helper). */
function readProp(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return Object.hasOwn(value, key) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}

/**
 * A resume-from-offset source with no retained chunks — used to flush/complete a stream that a
 * producer opened logically but never wrote to, so its transcript is still stamped `completed`
 * rather than left dangling `open`.
 */
const EMPTY_SOURCE: TranscriptRing = { since: () => ({ entries: [] }), nextOffset: 0 };

/** Per-stream bookkeeping the service keeps to drive lifecycle-aware persistence. */
interface StreamState {
  /** Retention lifecycle: `ephemeral` (flush+complete on job end) vs `long-lived` (reattach). */
  lifecycle: TranscriptLifecycle;
  /** The connection id of the most recent producer, for disconnect-driven completion. */
  producer?: string;
  /** Set once an ephemeral stream has been flushed & completed (so it is not re-completed). */
  completed: boolean;
  /**
   * Set once a `job:<jobKey>` stream has been linked into the correlation registry (H6, #149), so
   * the link is attempted at most once per stream. It stays `false` while the producer's presence
   * instance is not yet resolvable (a register/produce race), so a later `produce` frame retries.
   */
  linked: boolean;
}

/**
 * The minimal correlation write-side the relay slice drives (H6, #149): link a producing worker
 * instance to the jobKey it is relaying, and release it when the job's stream ends. Structural so
 * the service depends on a shape, not the whole {@link CorrelationRegistry}.
 */
export interface CorrelationLink {
  link(instance: string, jobKey: string, context?: JobContext): void;
  releaseJob(jobKey: string): void;
}

export interface RelayTranscriptServiceOptions {
  /** The app-tier hub; the service claims the `relay` family key via its registration seam. */
  readonly hub: {
    registerFamilyHandler(family: string, handler: (frame: Frame, conn: RelayConnectionCtx) => void): void;
  };
  /** The shared connection registry — its `has(id)` is the liveness source of truth. */
  readonly registry: ConnectionRegistry;
  /** The raw SQLite handle (the app DataLayer's `source().db`); absent → transcripts disabled. */
  readonly db: SqliteDb | undefined;
  /** A structured logger for lifecycle lines. */
  readonly log: Logger;
  /** Options forwarded to the underlying {@link RelayHub} (ring/bulk capacity, default credit). */
  readonly relay?: RelayHubOptions;
  /** Options forwarded to the {@link TranscriptStore} (retention window, injectable clock). */
  readonly transcript?: TranscriptStoreOptions;
  /**
   * Apply the transcript DDL from the store on mount (idempotent `CREATE ... IF NOT EXISTS`).
   * Default `true`: the boot migration is the canonical path, but this makes the service usable
   * against a bare source too (and is harmless when the migration already ran).
   */
  readonly ensureSchema?: boolean;
  /**
   * The correlation write-side seam (H6, #149). When present, a first `produce` frame for a
   * `job:<jobKey>` stream links the producing worker instance → jobKey here, and the stream's
   * completion / producer disconnect releases it. Defaults to the process-wide correlation registry
   * ({@link currentCorrelation}); absent (`() => undefined`) → no linking (advisory, never an error).
   */
  readonly correlation?: () => CorrelationLink | undefined;
  /**
   * Resolve the presence instance that owns a connection — the connection → instance join the
   * correlation write-side needs to attribute a `produce` frame's jobKey. Defaults to the mounted
   * presence registry's resolver; absent (returns undefined) → no linking.
   */
  readonly instanceForConnection?: (connectionId: string) => string | undefined;
}

/** The minimal per-connection surface the relay handler receives from the hub (a {@link RelayHub} `RelayConnection`). */
interface RelayConnectionCtx {
  readonly id: string;
  readonly registry: { has(id: string): boolean };
  send(frame: Frame): void;
}

/**
 * Composes the S5 relay ({@link RelayHub}) with the S6 transcript store ({@link TranscriptStore})
 * and wires retention-by-lifecycle. It owns NO ring/scheduler/store logic of its own — it observes
 * `produce` ownership so an ephemeral stream is flushed & completed when its producer disconnects,
 * and exposes the completion/checkpoint/reattach/sweep surface H6 (#149) and the app drive.
 */
export class RelayTranscriptService {
  /** The mounted relay hub (ring + QoS scheduler + incarnation fence). Exposed for inspection/tests. */
  readonly relay: RelayHub;
  /** The transcript store, or `undefined` when no DataLayer is mounted (relay still works, unpersisted). */
  readonly store: TranscriptStore | undefined;

  readonly #registry: ConnectionRegistry;
  readonly #log: Logger;
  readonly #streams = new Map<string, StreamState>();
  /** The correlation write-side accessor (H6, #149) — resolved per call so a late family mount wins. */
  readonly #correlation: () => CorrelationLink | undefined;
  /** The connection → producing-instance resolver (H6, #149). */
  readonly #instanceForConnection: (connectionId: string) => string | undefined;

  constructor(options: RelayTranscriptServiceOptions) {
    this.#registry = options.registry;
    this.#log = options.log;
    this.#correlation = options.correlation ?? currentCorrelation;
    this.#instanceForConnection = options.instanceForConnection ?? (() => undefined);
    // Persistence is advisory: a store that can't be constructed or whose schema can't be applied
    // (locked/permission-denied/unavailable SQLite) must NOT fail the family mount — fall back to
    // running the relay unpersisted rather than tearing down the whole agentic channel.
    let store: TranscriptStore | undefined;
    if (options.db) {
      try {
        store = new TranscriptStore(options.db, options.transcript);
        if (options.ensureSchema !== false) store.ensureSchema();
      } catch (err) {
        this.#log.warn("agentic transcript store unavailable — relay runs unpersisted", {
          err: String(err),
        });
        store = undefined;
      }
    }
    this.store = store;

    this.relay = new RelayHub({
      ...options.relay,
      onFenced: (stream, incarnation, current) => {
        this.#log.warn("agentic relay fenced a stale producer", { stream, incarnation, current });
        options.relay?.onFenced?.(stream, incarnation, current);
      },
      onError: (err, connectionId) => {
        this.#log.warn("agentic relay message error", { connectionId, err: String(err) });
        options.relay?.onError?.(err, connectionId);
      },
    });

    // Register the `relay` family ourselves (rather than via `registerRelayFamily`) so we can observe
    // `produce` ownership before delegating to the hub — the hub's own routing still derives purely
    // from this single registration, and a second `relay` registration is rejected by the seam.
    options.hub.registerFamilyHandler(RELAY_FAMILY, (frame, conn) => this.#onFrame(frame, conn));
  }

  /** The tracked stream names (those a producer opened or that were declared). */
  streams(): string[] {
    return [...this.#streams.keys()];
  }

  /**
   * Declare a stream's retention lifecycle before (or independently of) its first `produce`. The
   * durable store records lifecycle write-once (first call wins there); in memory the latest call
   * wins until the stream completes, which is how {@link checkpointStream} upgrades an as-yet
   * ephemeral stream to `long-lived`. No-op once the stream has already been completed.
   */
  declareLifecycle(stream: string, lifecycle: TranscriptLifecycle): void {
    const state = this.#stateFor(stream);
    if (!state.completed) state.lifecycle = lifecycle;
  }

  /**
   * Complete a stream on job end: flush the relay ring (its whole retained window) to the durable
   * transcript under the stream's lifecycle. For an `ephemeral` stream this stamps `completed_at`
   * (so {@link reattach} then serves the durable transcript and {@link sweep} may later retire it);
   * for a `long-lived` stream it is a snapshot checkpoint that leaves the stream `open`. Idempotent:
   * re-completing already-persisted offsets is a no-op. Returns the number of newly-persisted chunks.
   */
  completeStream(stream: string): number {
    if (!this.store) return 0;
    const state = this.#stateFor(stream);
    const source = this.relay.ring(stream) ?? EMPTY_SOURCE;
    let flushed: number;
    try {
      flushed = this.store.flush(stream, source, state.lifecycle);
    } catch (err) {
      // Persistence is advisory: a flush failure must not bubble into the hub's frame handler and
      // take down unrelated streams. Log and leave the stream uncompleted so a later pass retries.
      this.#log.warn("agentic relay stream flush failed — leaving stream uncompleted", {
        stream,
        lifecycle: state.lifecycle,
        err: String(err),
      });
      return 0;
    }
    if (state.lifecycle === "ephemeral") {
      state.completed = true;
      // Job end: release the jobKey ⇄ instance correlation so the worker's supply row clears it.
      this.#unlink(stream, state);
    }
    // Drop producer ownership so a later reconcile does not re-flush a completed stream.
    state.producer = undefined;
    this.#log.info("agentic relay stream flushed", {
      stream,
      lifecycle: state.lifecycle,
      flushed,
      completed: state.completed,
    });
    return flushed;
  }

  /**
   * Snapshot a long-lived stream's ring into the durable transcript without completing it — the
   * checkpoint path a growing stream uses so a reconnecting consumer can {@link reattach} past the
   * ring's resume window. Returns the number of newly-persisted chunks.
   */
  checkpointStream(stream: string): number {
    if (!this.store) return 0;
    this.declareLifecycle(stream, "long-lived");
    const source = this.relay.ring(stream) ?? EMPTY_SOURCE;
    try {
      return this.store.flush(stream, source, "long-lived");
    } catch (err) {
      // Advisory: a checkpoint failure keeps the relay usable — return 0, the stream stays open.
      this.#log.warn("agentic relay checkpoint flush failed", { stream, err: String(err) });
      return 0;
    }
  }

  /**
   * Reattach a consumer from offset `from` (inclusive) against the durable transcript — mirrors the
   * relay ring's `since` contract exactly, so a late/reconnecting consumer resumes identically
   * whether from the live ring or the persisted transcript. Returns `undefined` with no store.
   */
  reattach(stream: string, from: number): TranscriptSlice | undefined {
    return this.store?.since(stream, from);
  }

  /** Retention sweep: retire completed-ephemeral transcripts past the retention window. */
  sweep(now?: number): string[] {
    const retired = this.store?.sweep(now) ?? [];
    // Forget the in-memory state of every retired stream so `#streams` stays bounded (and
    // `#reconcile`'s scan stays cheap) even after many ephemeral streams complete and age out.
    for (const stream of retired) this.#streams.delete(stream);
    return retired;
  }

  /** A stream's persisted transcript metadata, if any (lifecycle/status/offset window). */
  transcriptOf(stream: string): TranscriptStream | undefined {
    return this.store?.get(stream);
  }

  /**
   * Complete every still-open ephemeral stream (e.g. on shutdown) so no in-flight terminal is lost,
   * then forget all tracking. Long-lived streams are left for reattach and are not force-completed.
   */
  teardown(): void {
    for (const [stream, state] of this.#streams) {
      if (state.lifecycle === "ephemeral" && !state.completed) this.completeStream(stream);
    }
    this.#streams.clear();
  }

  /** Handle one inbound `relay` frame: reconcile dead producers, observe ownership, then delegate. */
  #onFrame(frame: Frame, conn: RelayConnectionCtx): void {
    this.#reconcile();
    this.#observe(frame, conn);
    this.relay.handle(frame, conn);
  }

  /** Record `produce` ownership so a producer disconnect can drive ephemeral completion. */
  #observe(frame: Frame, conn: RelayConnectionCtx): void {
    if (readProp(frame.payload, "op") !== "produce") return;
    const stream = readProp(frame.payload, "stream");
    if (typeof stream !== "string" || stream === "") return;
    const state = this.#stateFor(stream);
    state.producer = conn.id;
    this.#link(stream, conn.id, state);
  }

  /**
   * H6 write-side (#149): on the first `produce` for a `job:<jobKey>` stream, link the producing
   * worker instance → jobKey in the correlation registry, from data already crossing the wire (the
   * jobKey is decoded from the stream id; the instance is resolved from the producing connection).
   * That lights up the worker's `jobKeys` in the supply feed and repoints its drill stream at the
   * jobKey-scoped relay stream. Idempotent per stream; retries on a later frame while the producer's
   * presence instance is not yet resolvable (a register/produce race). Advisory — never throws into
   * the frame handler.
   */
  #link(stream: string, connectionId: string, state: StreamState): void {
    if (state.linked) return;
    const jobKey = jobKeyOfStream(stream);
    if (jobKey === undefined) return;
    const instance = this.#instanceForConnection(connectionId);
    if (instance === undefined || instance === "") return;
    const correlation = this.#correlation();
    if (!correlation) return;
    correlation.link(instance, jobKey);
    state.linked = true;
  }

  /** H6 write-side (#149): release a `job:<jobKey>` stream's correlation on completion / disconnect. */
  #unlink(stream: string, state: StreamState): void {
    if (!state.linked) return;
    const jobKey = jobKeyOfStream(stream);
    if (jobKey === undefined) return;
    this.#correlation()?.releaseJob(jobKey);
    state.linked = false;
  }

  /**
   * Flush + complete every ephemeral stream whose producer connection is no longer live (the S1
   * registry dropped it on close or liveness timeout), and release its job correlation (H6, #149).
   * Lazy, like the relay hub's own dead-subscriber prune: it runs on each inbound frame, and shutdown
   * covers the quiescent tail via {@link teardown}. The correlation release is store-independent (it
   * runs even for an unpersisted relay), so a dropped worker's `jobKeys` always clear.
   */
  #reconcile(): void {
    for (const [stream, state] of this.#streams) {
      if (state.producer !== undefined && !this.#registry.has(state.producer)) {
        // Producer connection gone → the job it was relaying ended: release its correlation.
        this.#unlink(stream, state);
        // ...and flush+complete an ephemeral, not-yet-completed transcript exactly as before.
        if (!state.completed && state.lifecycle === "ephemeral") this.completeStream(stream);
      }
    }
  }

  #stateFor(stream: string): StreamState {
    let state = this.#streams.get(stream);
    if (state === undefined) {
      state = { lifecycle: "ephemeral", completed: false, linked: false };
      this.#streams.set(stream, state);
    }
    return state;
  }
}

/**
 * Build the H3 relay family. Copy-of-the-seam pattern: it constructs the {@link RelayTranscriptService}
 * in `mount` (threading the seam's hub/registry/DataLayer/log) and tears it down in `teardown`. The
 * created service is exposed to `onMounted` so a driver (H6 correlation, tests) can reach the
 * completion/reattach surface without re-mounting anything.
 *
 * It also (H3 read path, #222): installs the mounted service as the module singleton
 * {@link currentRelayTranscriptService} — so the advisory transcript READ endpoints (`GET
 * /agentic/transcripts*`) can source the {@link TranscriptStore} without re-mounting — and starts ONE
 * periodic retention sweep so completed-ephemeral transcripts are actually retired past the retention
 * window (the store defines the policy; this drives it, so the transcript table stays bounded).
 */
export function createRelayFamily(options: {
  readonly relay?: RelayHubOptions;
  readonly transcript?: TranscriptStoreOptions;
  readonly ensureSchema?: boolean;
  /** Called with the live service once mounted, so a driver can drive completion/reattach. */
  readonly onMounted?: (service: RelayTranscriptService) => void;
} = {}): AgenticFamily {
  let service: RelayTranscriptService | undefined;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  return {
    name: RELAY_FAMILY_NAME,
    mount(ctx: AgenticContext): void {
      service = new RelayTranscriptService({
        hub: ctx.hub,
        registry: ctx.registry,
        // The app's SQLite handle: the same store the advisory blackboard uses. Absent → relay runs
        // unpersisted (still advisory-correct), rather than failing the whole channel boot.
        db: ctx.data ? ctx.data.source().db : undefined,
        log: ctx.log,
        relay: options.relay,
        transcript: options.transcript,
        ensureSchema: options.ensureSchema,
        // H6 write-side (#149): resolve the producing connection's presence instance from the live
        // presence registry, and link/release against the process-wide correlation registry. Both
        // are read per call, so this works regardless of family mount order (relay may mount before
        // presence/correlation). Absent registries → no linking, still advisory-correct.
        instanceForConnection: (connectionId) => currentPresenceRegistry()?.instanceForConnection(connectionId),
        correlation: currentCorrelation,
      });
      setCurrentRelayTranscriptService(service);

      // Drive the store's retention-by-lifecycle policy: retire completed-ephemeral transcripts past
      // the retention window on a periodic tick so the durable table does not grow unbounded. Advisory
      // (a sweep fault is logged, never thrown) and never keeps the process alive on its own.
      const store = service.store;
      if (store) {
        const interval = sweepIntervalMs(store.ephemeralRetentionMs);
        const tick = () => {
          try {
            const retired = service?.sweep() ?? [];
            if (retired.length > 0) ctx.log.info("agentic transcript retention sweep", { retired: retired.length });
          } catch (err) {
            ctx.log.warn("agentic transcript retention sweep failed", { err: String(err) });
          }
        };
        sweepTimer = setInterval(tick, interval);
        sweepTimer.unref?.();
        // Run one sweep eagerly at mount so retention is enforced immediately: the transcript table is
        // durable across restarts, so without this first pass a completed-ephemeral transcript persisted
        // before downtime (and already past retention) would linger — listed by the read path — until the
        // first interval tick fires (potentially far off for a large retention window). Mirrors the
        // presence family's eager maintenance pass (derivation over duplication).
        tick();
      }

      options.onMounted?.(service);
    },
    teardown(): void {
      if (sweepTimer !== undefined) {
        clearInterval(sweepTimer);
        sweepTimer = undefined;
      }
      service?.teardown();
      if (currentService === service) setCurrentRelayTranscriptService(undefined);
      service = undefined;
    },
  };
}

/** The live relay service from the most recent mount, so the transcript READ endpoints (#222) can
 * source the durable {@link TranscriptStore} without re-mounting the family. */
let currentService: RelayTranscriptService | undefined;

/** The mounted relay/transcript service, or undefined before mount / after teardown. */
export function currentRelayTranscriptService(): RelayTranscriptService | undefined {
  return currentService;
}

/** Install the live service (called by the relay family's `mount`; cleared on `teardown`). */
export function setCurrentRelayTranscriptService(svc: RelayTranscriptService | undefined): void {
  currentService = svc;
}

/** The discovered family instance (the loader picks up this `family` export). */
export const family: AgenticFamily = createRelayFamily();

export default family;
