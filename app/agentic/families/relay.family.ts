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
  CORE_TRANSCRIPT_VOCAB,
  mergeTranscriptVocab,
  parseTranscriptEvent,
  type SqliteDb,
  type TranscriptLifecycle,
  type TranscriptRing,
  type TranscriptSlice,
  TranscriptStore,
  type TranscriptStoreOptions,
  type TranscriptStream,
  type TranscriptVocab,
} from "@nanobpm/agentic/transcript";
import type { Logger } from "@nanobpm/urban";
import { currentCorrelation, type JobContext, type JobCorrelation, jobKeyOfStream } from "../correlation.ts";
import { AgenticCorrelationStore } from "../correlation-store.ts";
import type { ElementInstanceResolver } from "../element-instance.ts";
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
 * Default cadence (ms) of the defensive engine-reconcile pass (#661) — the safety net that releases a
 * correlation whose engine JOB park is gone but whose terminal `lifecycle` event never arrived (an
 * unclean worker exit). 30s trades a small staleness bound for a light engine-read load; the precise,
 * immediate release stays the terminal-lifecycle path, so this only ever mops up unclean exits.
 */
const DEFAULT_ENGINE_RECONCILE_MS = 30_000;

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

/**
 * The defensive engine-reconcile cadence (ms) for a given config (#661), or `undefined` to DISABLE the
 * pass. An omitted config uses {@link DEFAULT_ENGINE_RECONCILE_MS}; a non-finite or non-positive value
 * (a broken config, or a deliberate opt-out) disables the pass rather than degrading into a 1ms busy
 * loop; a finite positive value is floored at 1ms (so a sub-millisecond config like 0.5 cannot floor
 * to 0 and degrade into a busy `setInterval(0)`) and capped at {@link MAX_TIMER_MS} so a large window
 * cannot overflow Node's 32-bit timer.
 */
export function engineReconcileMs(configuredMs?: number): number | undefined {
  const value = configuredMs ?? DEFAULT_ENGINE_RECONCILE_MS;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(MAX_TIMER_MS, Math.max(1, Math.floor(value)));
}

/**
 * Wrap an async pass in an in-flight guard so a periodic `setInterval` never fires OVERLAPPING runs
 * (#661). A single pass of {@link RelayTranscriptService.reconcileEngineCorrelations} awaits an engine
 * read per linked job, so a pass can outlast its interval (a small configured cadence, or a slow/large
 * engine read-model); an unguarded `setInterval` would then stack concurrent passes, piling up engine
 * reads and log volume. While a pass is still pending, every subsequent tick is skipped; the next tick
 * after it settles — whether it resolves OR rejects, since the guard clears via `.finally` — starts a
 * fresh pass. The guard clears on BOTH failure modes so it can never wedge in-flight: (1) a
 * *synchronous* throw from `pass` escapes before `.finally` is attached, so it is caught here — the
 * guard is re-armed and the fault is re-thrown so it stays loud rather than being silently swallowed;
 * (2) an async rejection is cleared by `.finally`, but the tick `void`s (does not await) the returned
 * promise, so `pass` must still settle its own rejections or an unhandled rejection results — which is
 * why the mount wraps `reconcileEngineCorrelations()` in `.catch`. Making the guard resilient to (1)
 * removes a subtle footgun for a future caller (or refactor) that returns a non-`async` `pass`. Mirrors
 * the "one pass at a time" discipline the main poll loop enforces by self-scheduling. Returns the tick
 * callback to hand to `setInterval`.
 */
export function guardOverlappingPasses(pass: () => Promise<void>): () => void {
  let inFlight = false;
  return () => {
    if (inFlight) return;
    inFlight = true;
    try {
      void pass().finally(() => {
        inFlight = false;
      });
    } catch (err) {
      // A synchronous throw never attaches the `.finally`; re-arm the guard so it does not wedge,
      // then re-throw so a contract violation still surfaces instead of being silently swallowed.
      inFlight = false;
      throw err;
    }
  };
}

/** Read a property off an unknown value without an unsafe `as` cast (mirrors the loader's helper). */
function readProp(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return Object.hasOwn(value, key) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}

/**
 * The harness's job-end lifecycle phase (#710 / jwulf/c8ctl-plugin-nano#150): the closing twin of the
 * `phase:"open"` `RELAY_OPEN_CHUNK` the harness emits at relay-session open. The harness emits it —
 * through agentic's own `encodeTranscriptEvent`, never hand-rolled — right before `job.complete`/
 * `job.fail`, once it has DRAINED its outbound relay buffer, so it is the deterministic "this job's
 * bytes are all here, it is done" signal that supersede/disconnect only ever approximated.
 */
const HARNESS_CLOSE_PHASE = "close";

/**
 * The relay family's terminal-detection vocabulary: the ONE canonical transcript vocab, additively
 * EXTENDED (via the sanctioned {@link mergeTranscriptVocab} extension point, never a forked parser) to
 * ALSO classify the harness's job-end `phase:"close"` marker (#710). The agentic `LifecycleEvent`
 * contract's phases are `open|completed|exited` — `close` is a fourth, job-scoped termination marker
 * agentic 0.10.0 does not yet know, so the core `lifecycle` decoder drops it to a raw `stream-chunk`.
 * This override recognizes it and maps it onto the contract's terminal `completed` phase, so
 * {@link parseTranscriptEvent} classifies a close envelope as a terminal lifecycle WITHOUT a second
 * wire shape. It is scoped to {@link isTerminalLifecycleChunk} (the correlation-release detector); the
 * cockpit derive/read fold keeps using the CORE vocab, so the close chunk stays byte-faithful in the
 * durable transcript and this remap never leaks into the derived view.
 */
const RELAY_TERMINAL_VOCAB: TranscriptVocab = mergeTranscriptVocab(CORE_TRANSCRIPT_VOCAB, {
  lifecycle: (body, offset) => {
    const phase = typeof body.phase === "string" ? body.phase : undefined;
    if (phase === "open" || phase === "completed" || phase === "exited") return { kind: "lifecycle", offset, phase };
    if (phase === HARNESS_CLOSE_PHASE) return { kind: "lifecycle", offset, phase: "completed" };
    return undefined;
  },
});

/**
 * Decode a single relay chunk through the ONE canonical transcript parser and report whether it is a
 * TERMINAL `lifecycle` event — the authoritative "job end" signal that flushes the durable transcript
 * and releases correlation. Two shapes are terminal: the agent run's own `phase` `completed`/`exited`
 * (#661), and the harness's drained job-end `phase:"close"` marker (#710), which
 * {@link RELAY_TERMINAL_VOCAB} decodes onto the contract's `completed` phase. Anything else — raw
 * terminal bytes, a non-envelope JSON value, a `phase: "open"` lifecycle, any other event kind — is
 * not terminal. Reusing {@link parseTranscriptEvent} (with the additively-extended vocab) keeps
 * transcript-vocab knowledge out of the content-agnostic relay ring and off any forked decoder
 * (Derivation Over Duplication): the ring still sees opaque bytes; only this narrow seam classifies
 * them.
 */
function isTerminalLifecycleChunk(chunk: string): boolean {
  const event = parseTranscriptEvent({ offset: 0, chunk }, RELAY_TERMINAL_VOCAB);
  return event.kind === "lifecycle" && (event.phase === "completed" || event.phase === "exited");
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
  /**
   * When this stream's in-memory state was first opened, ISO-8601 (stamped from the service clock).
   * The durable transcript row carries its own `created_at` (stamped at flush/`open`), but a
   * still-live ephemeral stream has no durable row yet (#486): its ring holds the captured bytes but
   * the store 404s until a producer disconnect / supersede flushes it. This is the authoritative
   * "when opened" for {@link RelayTranscriptService.liveFallback} to serve the pre-flush ring.
   */
  createdAt: string;
  /**
   * The worker instance a `job:<jobKey>` stream was linked under (H6). Recorded so a stream's release
   * (completion / disconnect) can tidy the {@link RelayTranscriptService.#jobStreamByInstance}
   * supersede index, and so the "one job at a time per worker" supersede rule can identify the
   * instance's prior job stream.
   */
  instance?: string;
  /**
   * The engine element-instance key this `job:<jobKey>` stream's job occupies (#544), once the
   * asynchronous link-time resolution ({@link RelayTranscriptService.#resolveElementInstance}) lands.
   * Stashed on the stream so job completion can persist it even if the live correlation was already
   * enriched-and-released, and so a resolution that returns after completion can still be recognised.
   */
  elementInstanceKey?: string;
}

/**
 * The minimal correlation write-side the relay slice drives (H6, #149): link a producing worker
 * instance to the jobKey it is relaying, and release it when the job's stream ends. Structural so
 * the service depends on a shape, not the whole {@link CorrelationRegistry}.
 */
export interface CorrelationLink {
  link(instance: string, jobKey: string, context?: JobContext): void;
  releaseJob(jobKey: string): void;
  /**
   * Enrich a still-linked job's context with the engine element-instance key it occupies (#544),
   * resolved asynchronously after the link. Optional so the minimal double in tests need not implement
   * it; the real {@link CorrelationRegistry} does. A no-op once the job is released.
   */
  attachElementInstance?(jobKey: string, elementInstanceKey: string): void;
  /**
   * The (still-live) engine context for a jobKey, when the write-side exposes it. Optional so the
   * minimal double in tests need not implement it; the real {@link CorrelationRegistry} does, and the
   * relay slice reads it at completion to persist a job's process-instance / plan context durably
   * before the correlation is released (#485).
   */
  resolve?(jobKey: string): JobCorrelation | undefined;
}

/** A worker's durable identity attributes, resolved from the presence registry at completion time. */
export interface WorkerAttribution {
  readonly identity?: string;
  readonly host?: string;
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
   * correlation write-side needs to attribute a `produce` frame's jobKey. When omitted,
   * `RelayTranscriptService` defaults it to `() => undefined` (no linking); the family factory
   * {@link createRelayFamily} is what wires it to the mounted presence registry's resolver
   * ({@link currentPresenceRegistry}). A resolver returning undefined → no linking (advisory).
   */
  readonly instanceForConnection?: (connectionId: string) => string | undefined;
  /**
   * Whether a worker instance is still live on any hub connection (#689). Wired to the presence
   * registry's {@link PresenceRegistry.isInstanceLive}. Since #691 the disconnect-driven reconcile
   * defers to the engine job-state (the poller-owned completion authority) whenever an engine view
   * ({@link resolveElementInstance}) is wired, so this presence signal is consulted ONLY as the
   * engine-less fallback: on a host with no engine read-model (or a non-job stream — no jobKey, so
   * nothing for the engine to reconcile against; an unlinked *job* stream still has a jobKey and DOES
   * reconcile against the engine since #691) it spares a still-active job's stream when its worker merely
   * RECONNECTED mid-job (old producer connection dropped, a new one re-registered under the same
   * instance) — completing then would archive a live job's transcript and release its correlation,
   * wedging the cockpit (the reconnected worker's produce frames hit a terminal `completed` stream and
   * are ignored). A true worker-exit still completes (presence has dropped the instance → false).
   * Omitted (`() => false`, the static default) → the prior always-complete-on-disconnect behaviour in
   * that fallback path.
   */
  readonly isInstanceLive?: (instance: string) => boolean;
  /**
   * Resolve a producing worker instance's durable identity attributes (identity / host) — read at
   * job-completion time and persisted with the attribution so a PAST session stays attributable to a
   * worker after it exits (#485). {@link createRelayFamily} wires it to the presence registry; omitted
   * → attribution is recorded with instance only (still attributable), never an error.
   */
  readonly attributionForInstance?: (instance: string) => WorkerAttribution | undefined;
  /**
   * The durable worker-attribution store (#485). Omitted → constructed from {@link db} (absent db →
   * no durable attribution). Injectable so a test can supply an in-memory store.
   */
  readonly correlationStore?: AgenticCorrelationStore;
  /**
   * Resolve the engine element-instance key a `job:<jobKey>` stream's job occupies (#544). Called
   * fire-and-forget on the first `produce` (while the job's JOB park is still live), and its result
   * enriches the live correlation context / durable attribution so a captured session is keyed on the
   * element INSTANCE (unambiguous across a looping / retried job), not just the static element id.
   * Advisory and READ-ONLY — never awaited in a frame handler, never gates a flow. {@link createRelayFamily}
   * wires it to the channel's {@link AgenticContext.resolveElementInstance}; omitted → no enrichment.
   */
  readonly resolveElementInstance?: ElementInstanceResolver;
  /** "Now" as an ISO-8601 instant, injectable for deterministic completion timestamps. */
  readonly now?: () => string;
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

  /** The durable worker-attribution store (#485), or `undefined` when unpersisted. Exposed so the read path can attribute released jobs. */
  get correlationStore(): AgenticCorrelationStore | undefined {
    return this.#correlationStore;
  }

  readonly #registry: ConnectionRegistry;
  readonly #log: Logger;
  readonly #streams = new Map<string, StreamState>();
  /**
   * The `job:<jobKey>` relay stream each worker instance is CURRENTLY relaying (H6, #149). A worker
   * relays every job it runs over one long-lived channel connection, one job at a time
   * (`../correlation.ts`), so that connection never disconnects between jobs — the disconnect-driven
   * `#reconcile` release never fires. This index lets a NEW job's first `produce` supersede the
   * worker's PRIOR job (complete its stream → flush transcript + release correlation), so a supply
   * row shows only the current job instead of accumulating every job the connection ever ran.
   */
  readonly #jobStreamByInstance = new Map<string, string>();
  /** The correlation write-side accessor (H6, #149) — resolved per call so a late family mount wins. */
  readonly #correlation: () => CorrelationLink | undefined;
  /** The connection → producing-instance resolver (H6, #149). */
  readonly #instanceForConnection: (connectionId: string) => string | undefined;
  /** Whether a worker instance is still live on any connection (#689) — gates disconnect completion. */
  readonly #isInstanceLive: (instance: string) => boolean;
  /** Resolve a worker instance's durable identity attributes for attribution (#485). */
  readonly #attributionForInstance: (instance: string) => WorkerAttribution | undefined;
  /** The durable worker-attribution store, or undefined when unpersisted (#485). */
  readonly #correlationStore: AgenticCorrelationStore | undefined;
  /** Resolve the engine element-instance key a job occupies (#544), or undefined when not wired. */
  readonly #resolveElementInstance: ElementInstanceResolver | undefined;
  /** "Now" as an ISO-8601 instant (injectable for deterministic tests). */
  readonly #now: () => string;

  constructor(options: RelayTranscriptServiceOptions) {
    this.#registry = options.registry;
    this.#log = options.log;
    this.#correlation = options.correlation ?? currentCorrelation;
    this.#instanceForConnection = options.instanceForConnection ?? (() => undefined);
    this.#isInstanceLive = options.isInstanceLive ?? (() => false);
    this.#attributionForInstance = options.attributionForInstance ?? (() => undefined);
    this.#resolveElementInstance = options.resolveElementInstance;
    this.#now = options.now ?? (() => new Date().toISOString());
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

    // The durable worker-attribution store (#485) — advisory, same failure posture as the transcript
    // store: an unbuildable store falls back to no durable attribution, never a mount failure.
    let correlationStore = options.correlationStore;
    if (correlationStore === undefined && options.db) {
      try {
        correlationStore = new AgenticCorrelationStore(options.db);
      } catch (err) {
        this.#log.warn("agentic correlation store unavailable — past sessions unattributed", {
          err: String(err),
        });
        correlationStore = undefined;
      }
    }
    this.#correlationStore = correlationStore;

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
    const state = this.#stateFor(stream);
    const source = this.relay.ring(stream) ?? EMPTY_SOURCE;
    let flushed = 0;
    // Persistence is advisory: with no store there is nothing to flush, but the in-memory lifecycle
    // must still transition (mark completed, unlink correlation, drop producer) so an unpersisted
    // ephemeral stream completes exactly once and #reconcile does not keep retrying it every frame.
    if (this.store) {
      try {
        flushed = this.store.flush(stream, source, state.lifecycle);
      } catch (err) {
        // A flush failure must not bubble into the hub's frame handler and take down unrelated
        // streams. Log and leave the stream uncompleted so a later pass retries.
        this.#log.warn("agentic relay stream flush failed — leaving stream uncompleted", {
          stream,
          lifecycle: state.lifecycle,
          err: String(err),
        });
        return 0;
      }
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

  /** Handle one inbound `relay` frame: reconcile dead producers, observe ownership, delegate, then
   * release on a terminal `lifecycle` event (#661/#710 — AFTER the hub appended the chunk, so the
   * terminal event itself is captured in the flushed transcript). */
  #onFrame(frame: Frame, conn: RelayConnectionCtx): void {
    this.#reconcile();
    this.#observe(frame, conn);
    this.relay.handle(frame, conn);
    this.#observeTerminalLifecycle(frame);
  }

  /**
   * Primary job-end release (#661, #710): when a `produce` frame carries a terminal `lifecycle` event —
   * the agent run's own `phase` `completed`/`exited` (#661), OR the harness's drained job-end
   * `phase:"close"` marker (#710) — complete its stream so the worker's job⇄instance correlation is
   * released, and the durable "past session" transcript is flushed, the moment the job ends. This runs
   * even though the worker's relay connection stays open across jobs (the disconnect/supersede release
   * paths miss that idle-after-last-job tail, so an idle worker's finished job would otherwise linger as
   * a phantom active job on its supply row, and its transcript would be snapshotted late → truncated
   * tail). The `close` trigger is ADDITIVE — supersede + disconnect remain as belt-and-suspenders
   * fallbacks for a harness that predates the close event or a crash that never sends one — and the
   * `state.completed` guard below makes a close-then-later-disconnect (or a duplicate close) an
   * idempotent no-op. Runs AFTER the hub appends the chunk to the ring, so the terminal event is part
   * of the flushed transcript. A narrow, self-contained decode at the correlation seam that reuses the
   * ONE canonical {@link parseTranscriptEvent} ({@link isTerminalLifecycleChunk}) — the content-agnostic
   * relay ring keeps treating chunks as opaque bytes, and no transcript-vocab knowledge is forked into
   * it. Non-terminal chunks (raw bytes, a `phase: "open"` lifecycle, any other event kind) never
   * complete a live stream, so a genuinely active job is never cleared. Advisory — never throws into
   * the frame handler.
   */
  #observeTerminalLifecycle(frame: Frame): void {
    if (readProp(frame.payload, "op") !== "produce") return;
    const stream = readProp(frame.payload, "stream");
    if (typeof stream !== "string" || stream === "") return;
    const chunk = readProp(frame.payload, "chunk");
    if (typeof chunk !== "string" || chunk === "") return;
    const state = this.#streams.get(stream);
    // Idempotent: an unknown or already-completed stream needs no (further) release — a second terminal
    // event, or a late one after the disconnect/supersede path already completed the stream, is a no-op.
    if (state === undefined || state.completed) return;
    if (!isTerminalLifecycleChunk(chunk)) return;
    this.completeStream(stream);
  }

  /** Record `produce` ownership so a producer disconnect can drive ephemeral completion. */
  #observe(frame: Frame, conn: RelayConnectionCtx): void {
    if (readProp(frame.payload, "op") !== "produce") return;
    const stream = readProp(frame.payload, "stream");
    if (typeof stream !== "string" || stream === "") return;
    const state = this.#stateFor(stream);
    // A completed stream is terminal: a late `produce` frame (e.g. arriving after job-end
    // completion released the correlation) must not re-own or re-link it — doing so would
    // resurrect a jobKey after it was released. Ignore ownership updates once completed.
    if (state.completed) return;
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
    try {
      // One job at a time per worker (`../correlation.ts`): the worker relaying a NEW job's terminal
      // over its live connection PROVES its prior job finished. Supersede it — complete the prior
      // stream (flush transcript → durable past session, release its correlation) BEFORE linking the
      // new one — so the worker's supply row never accumulates jobs the disconnect-driven release
      // would otherwise strand behind a connection that stays open across jobs.
      const priorStream = this.#jobStreamByInstance.get(instance);
      if (priorStream !== undefined && priorStream !== stream) this.completeStream(priorStream);
      correlation.link(instance, jobKey);
      state.linked = true;
      state.instance = instance;
      this.#jobStreamByInstance.set(instance, stream);
      // #544: resolve the element INSTANCE this job occupies while its JOB park is still live (the
      // park is gone once the job completes, so this must fire at link time, not completion time).
      // Advisory and asynchronous — fire-and-forget so it never blocks the synchronous frame handler.
      this.#enrichElementInstance(stream, jobKey, state);
    } catch (err) {
      // Advisory — never throws into the frame handler. Swallow a throwing injectable correlation and
      // leave the stream UNLINKED so a later `produce` retries the link.
      this.#log.warn("agentic relay correlation link failed — leaving stream unlinked", {
        stream,
        jobKey,
        err: String(err),
      });
    }
  }

  /**
   * #544: asynchronously resolve the engine element-instance key this job occupies and record it, from
   * the first `produce` while the JOB park is still live. Fire-and-forget: it is invoked from the
   * synchronous frame handler but never awaited, and every failure is swallowed (advisory). On success
   * it enriches BOTH the live correlation context (so a still-running job's reads see it) AND stashes
   * it on the stream state (so completion persists it); it ALSO backfills the durable row directly, to
   * cover the race where resolution returns AFTER the job completed and released its live correlation.
   */
  #enrichElementInstance(stream: string, jobKey: string, state: StreamState): void {
    const resolve = this.#resolveElementInstance;
    if (resolve === undefined) return;
    const processInstanceKey = this.#correlation()?.resolve?.(jobKey)?.processInstanceKey;
    // Self-contained advisory: a synchronous throw (a misbehaving resolver) is swallowed here rather
    // than surfacing in `#link`'s catch as a misleading "link failed", and the async rejection path is
    // handled by `.catch`. Either way this never throws into the synchronous frame handler.
    let pending: Promise<string | undefined>;
    try {
      pending = resolve(jobKey, processInstanceKey);
    } catch (err) {
      this.#log.warn("agentic relay element-instance resolution failed — session left un-keyed", {
        stream,
        jobKey,
        err: String(err),
      });
      return;
    }
    void pending
      .then((elementInstanceKey) => {
        if (elementInstanceKey === undefined || elementInstanceKey === "") return;
        state.elementInstanceKey = elementInstanceKey;
        // Enrich the live context if still linked (a no-op once released), and backfill the durable
        // row if it was already persisted (a no-op before completion) — the two are complementary, so
        // exactly one lands depending on whether resolution beat completion.
        this.#correlation()?.attachElementInstance?.(jobKey, elementInstanceKey);
        this.#correlationStore?.setElementInstanceKey(jobKey, elementInstanceKey);
      })
      .catch((err: unknown) => {
        this.#log.warn("agentic relay element-instance resolution failed — session left un-keyed", {
          stream,
          jobKey,
          err: String(err),
        });
      });
  }

  /** H6 write-side (#149): release a `job:<jobKey>` stream's correlation on completion / disconnect. */
  #unlink(stream: string, state: StreamState): void {
    if (!state.linked) return;
    const jobKey = jobKeyOfStream(stream);
    if (jobKey === undefined) return;
    try {
      // Persist the completed job's durable worker attribution + (best-effort) engine context BEFORE
      // releasing the live correlation, so a PAST session stays attributable to a worker after it
      // exits (#485) — the in-memory registry is about to forget it. Advisory, best-effort.
      this.#persistAttribution(stream, jobKey, state);
      this.#correlation()?.releaseJob(jobKey);
      state.linked = false;
      // Tidy the supersede index so it never points a released instance at a completed stream and
      // stays bounded across the worker's lifetime.
      if (state.instance !== undefined && this.#jobStreamByInstance.get(state.instance) === stream) {
        this.#jobStreamByInstance.delete(state.instance);
      }
    } catch (err) {
      // Advisory — never throws into the frame handler. Swallow a throwing injectable correlation and
      // leave `state.linked` true so the flag honestly records that the release did NOT happen (rather
      // than falsely clearing it). Note there is no automatic retry once the stream completes:
      // `completeStream` sets `state.completed` and clears `state.producer`, so `#reconcile` no longer
      // revisits it and `teardown` skips already-completed streams. A retry only occurs on the
      // dead-producer path, where `#reconcile` re-invokes `#unlink` on a still-uncompleted stream.
      this.#log.warn("agentic relay correlation release failed — leaving stream linked", {
        stream,
        jobKey,
        err: String(err),
      });
    }
  }

  /**
   * Record a completed job's durable attribution (#485): which worker ran it (instance + presence
   * identity/host) and its still-live engine context (process instance / plan), keyed by jobKey, so
   * the transcript read path can attribute the PAST session after the live correlation is released
   * and after a restart. Advisory — a persistence fault is logged, never thrown into the frame
   * handler, and never blocks the correlation release.
   */
  #persistAttribution(stream: string, jobKey: string, state: StreamState): void {
    const store = this.#correlationStore;
    const instance = state.instance;
    if (store === undefined || instance === undefined || instance === "") return;
    try {
      const attribution = this.#attributionForInstance(instance) ?? {};
      const context = this.#correlation()?.resolve?.(jobKey);
      // #544: prefer the live context's element-instance key; fall back to the stream state (the
      // resolution may have landed after the context was released, or the context write-side may not
      // carry it). Either source is the same resolved value.
      const elementInstanceKey = context?.elementInstanceKey ?? state.elementInstanceKey;
      store.record({
        jobKey,
        stream,
        instance,
        completedAt: this.#now(),
        ...(attribution.identity !== undefined ? { identity: attribution.identity } : {}),
        ...(attribution.host !== undefined ? { host: attribution.host } : {}),
        ...(context?.processInstanceKey !== undefined ? { processInstanceKey: context.processInstanceKey } : {}),
        ...(context?.bpmnProcessId !== undefined ? { bpmnProcessId: context.bpmnProcessId } : {}),
        ...(context?.elementId !== undefined ? { elementId: context.elementId } : {}),
        ...(context?.planKey !== undefined ? { planKey: context.planKey } : {}),
        ...(elementInstanceKey !== undefined ? { elementInstanceKey } : {}),
      });
    } catch (err) {
      this.#log.warn("agentic correlation attribution persist failed — past session left unattributed", {
        stream,
        jobKey,
        err: String(err),
      });
    }
  }

  /**
   * Reconcile every ephemeral stream whose producer connection is no longer live (the S1 registry
   * dropped it on close or liveness timeout). For a job stream with an engine view wired this
   * defers the completion decision to the engine job-state (#691) — the poller-owned authority —
   * regardless of whether the stream is linked yet (an unlinked job stream can still be mid-reconnect
   * on the register/produce race), so a mid-job reconnect never archives a still-active job; for an
   * engine-less host (or a non-job stream with no engine job to reconcile against) it flushes +
   * completes the ephemeral stream and releases its correlation (H6, #149), with
   * presence liveness (#689/#690) sparing a still-live instance as the only fallback signal. Lazy, like
   * the relay hub's own dead-subscriber prune: it runs on each inbound frame, and shutdown covers the
   * quiescent tail via {@link teardown}. The correlation release is store-independent (it runs even for
   * an unpersisted relay), so a dropped worker's `jobKeys` always clear.
   */
  #reconcile(): void {
    for (const [stream, state] of this.#streams) {
      if (state.producer !== undefined && !this.#registry.has(state.producer)) {
        // Producer connection gone. Normally that means the job it was relaying ended — but a worker
        // that merely RECONNECTED mid-job (#689) also loses its old producer connection while its job
        // keeps running (the harness holds the engine lease and extends it). Inferring job-end from the
        // relay-connection layer (the old presence heuristic, #690) conflates two independent liveness
        // signals (engine lease vs. WS connection); the authoritative one is the engine job-state the
        // poller already reconciles (#691).
        if (this.#resolveElementInstance !== undefined && jobKeyOfStream(stream) !== undefined) {
          // Engine/poller-owned completion (#691): drop the dead producer so `#reconcile` does not
          // re-trigger on every subsequent frame, then reconcile THIS stream against the engine's view
          // of its job (fire-and-forget — the sync frame handler must not await an engine read). A
          // reconnected worker's job is still parked → kept live (the reconnect's next `produce`
          // re-attributes the live connection via `#observe`); a genuine exit's job is gone →
          // completed + archived. The periodic {@link reconcileEngineCorrelations} pass is the backstop
          // if this read faults transiently. Presence liveness is no longer consulted here — the
          // engine job-state is the sole completion authority whenever an engine view is wired.
          //
          // NB: this deliberately does NOT require `state.linked`. A job stream can still be UNLINKED
          // during the documented register/produce race (the producer's presence instance was not yet
          // resolvable at `produce` time, so `#link` deferred). Gating the engine path on `linked`
          // would fall an unlinked-but-engine-wired job through to the presence fallback below and
          // archive a still-parked job mid-reconnect — the very heuristic #691 removes. The engine is
          // resolvable by jobKey alone (as at link time), so defer to it regardless of `linked`;
          // `#unlink` inside `completeStream` stays a no-op for a stream that never linked.
          state.producer = undefined;
          void this.#reconcileStreamAgainstEngine(stream).catch((err: unknown) => {
            this.#log.warn("agentic relay disconnect engine-reconcile failed", { stream, err: String(err) });
          });
          continue;
        }
        // Engine-less fallback (no engine view wired — e.g. an engine-less host, or a non-job stream
        // with no engine job to reconcile against): presence-liveness spares a still-live
        // instance's stream (#689/#690) and a truly-gone instance completes. Presence remains a
        // completion signal ONLY in this degraded path where there is no engine job-state to consult —
        // never the sole authority on the engine-wired path above. (A job stream with an engine view
        // wired always took the engine path above, linked or not — it never reaches here.)
        if (state.instance !== undefined && this.#isInstanceLive(state.instance)) continue;
        // Producer connection gone → the job it was relaying ended: release its correlation.
        this.#unlink(stream, state);
        // ...and flush+complete an ephemeral, not-yet-completed transcript exactly as before.
        if (!state.completed && state.lifecycle === "ephemeral") this.completeStream(stream);
      }
    }
  }

  /**
   * Defensive engine-reconcile safety net (#661): release any job stream — linked OR unlinked (#708) —
   * whose engine JOB park is no longer live. The precise, fast release is the terminal `lifecycle` event
   * ({@link #observeTerminalLifecycle}), but an UNCLEAN worker exit (crash/kill) can skip that event —
   * and because the worker's relay connection is persistent across jobs, the disconnect release never
   * fires either, so the finished job would linger as a phantom active job on the worker's supply row.
   * This periodic pass asks the engine read model (the same {@link ElementInstanceResolver} the link
   * path uses at #544) whether each job is still parked; a job the engine no longer parks
   * (resolver returns `undefined`) is released and its transcript completed. Bounds staleness regardless
   * of whether the worker emitted a clean terminal event — and also covers a worker that emitted nothing
   * and merely went quiet. It covers UNLINKED job streams too (#708): the disconnect path (#691)
   * can leave a job stream unlinked-but-still-parked with no producer, and jobKey alone resolves
   * terminality, so this backstop is the only actor that can retire one whose worker never reconnects.
   *
   * Advisory and best-effort: a no-op with no resolver wired, and a resolver THROW / REJECTION for a
   * given job is treated as "unknown — keep it" (never a false release of a genuinely active
   * job). The job-stream set is snapshotted before any await so a concurrent completion (a terminal
   * lifecycle event landing mid-pass) cannot corrupt iteration, and each release re-checks the current
   * stream state so a job already released between snapshot and resolution is not double-completed.
   */
  async reconcileEngineCorrelations(): Promise<void> {
    if (this.#resolveElementInstance === undefined) return;
    // Snapshot the job-stream ids BEFORE any await so a concurrent completion (a terminal lifecycle
    // event, a supersede, or a disconnect-triggered engine reconcile landing mid-pass) cannot corrupt
    // iteration; the per-stream helper re-reads live state, so a job released between snapshot and
    // resolution is not double-completed.
    const streams: string[] = [];
    for (const [stream, state] of this.#streams) {
      if (state.completed) continue;
      if (jobKeyOfStream(stream) === undefined) continue;
      // Include UNLINKED job streams too (#708). The disconnect path (#691) routes an unlinked
      // job stream through the engine reconcile and clears `state.producer`, so if the engine
      // reports "still parked" at disconnect (or the read faults transiently) and the worker never
      // reconnects to `produce` a link, this periodic pass is the ONLY actor left that can retire
      // it. jobKey alone resolves terminality (as at link time), so gating this snapshot on
      // `state.linked` would leak such a stream live forever once its engine job becomes terminal.
      streams.push(stream);
    }
    for (const stream of streams) await this.#reconcileStreamAgainstEngine(stream);
  }

  /**
   * Reconcile ONE `job:<jobKey>` stream against the engine's view of its job (the poller-owned
   * completion authority, #691). Asks the engine read model (the {@link ElementInstanceResolver} the
   * #544 link path uses) whether the job is still parked: still parked → genuinely active, kept live;
   * gone → ended (a clean completion whose terminal lifecycle event was missed, or an unclean exit) →
   * released + its transcript flushed/archived. This is the single canonical engine-reconcile step,
   * shared by BOTH the periodic safety-net pass ({@link reconcileEngineCorrelations}) and the
   * disconnect-driven `#reconcile` — so a producer disconnect no longer completes a stream by inferring
   * job-end from relay-connection/presence liveness (#689/#690), but by the authoritative engine
   * job-state. A no-op with no resolver wired, and a resolver THROW / REJECTION is treated as
   * "unknown — keep it" so a transient engine read never falsely releases a genuinely active
   * job (a later pass, or the terminal lifecycle event, releases it). Re-reads live state before
   * completing so a job released between the read and the completion is not double-completed.
   *
   * Does NOT require `state.linked`: the disconnect path (#691) also routes an UNLINKED job stream
   * here (a job stream whose link deferred on the register/produce race), so the engine — not the
   * link flag — owns its completion. The engine resolves by jobKey alone (as at link time); an
   * unlinked stream the engine says is gone is still flushed/archived, and `#unlink` inside
   * `completeStream` stays a no-op for it.
   */
  async #reconcileStreamAgainstEngine(stream: string): Promise<void> {
    const resolve = this.#resolveElementInstance;
    if (resolve === undefined) return;
    const before = this.#streams.get(stream);
    if (before === undefined || before.completed) return;
    const jobKey = jobKeyOfStream(stream);
    if (jobKey === undefined) return;
    const processInstanceKey = this.#correlation()?.resolve?.(jobKey)?.processInstanceKey;
    let activeKey: string | undefined;
    try {
      activeKey = await resolve(jobKey, processInstanceKey);
    } catch (err) {
      // A transient engine read failure must NOT be read as "job gone" — keep the stream live; a
      // later pass (or the terminal lifecycle event) releases it. Advisory, never a false release.
      this.#log.warn("agentic relay engine-reconcile read failed — keeping stream live", {
        stream,
        jobKey,
        err: String(err),
      });
      return;
    }
    // A live JOB park (a resolved element-instance key) means the job is genuinely active — keep it.
    // This is what spares a mid-job RECONNECT: the harness still holds the engine lease, so the job is
    // still parked even though the old producer connection dropped.
    if (activeKey !== undefined) return;
    // The engine no longer parks this job → it ended (possibly via an unclean exit that skipped the
    // terminal lifecycle event). Re-check the current state — a concurrent completion may already
    // have released it — then release its correlation and flush its transcript.
    const current = this.#streams.get(stream);
    if (current === undefined || current.completed) return;
    this.#log.info("agentic relay engine-reconcile released a stale correlation", { stream, jobKey });
    this.completeStream(stream);
  }

  /**
   * The still-live relay ring for a stream, for the read path to serve BEFORE a durable flush (#486).
   *
   * A multiplexing worker relays every job over one long-lived connection, one job at a time, so an
   * ephemeral job stream is only flushed to the durable store when the worker disconnects or a NEW
   * job supersedes it — NOT when the job itself completes. In the window between "job completed
   * (`transcriptUrl` emitted)" and that flush, {@link TranscriptStore.get} returns undefined and the
   * transcript endpoint would 404 the freshly-emitted URL. This exposes the live ring (+ its opened-at
   * instant) so {@link readTranscriptFrom} can serve the captured bytes directly, making the URL
   * readable the moment it is emitted. Returns undefined when there is no live ring, or once the
   * stream has been completed (the durable store is then the source of truth).
   */
  liveFallback(stream: string): { ring: TranscriptRing; createdAt: string } | undefined {
    const ring = this.relay.ring(stream);
    if (ring === undefined) return undefined;
    const state = this.#streams.get(stream);
    if (state?.completed) return undefined;
    return { ring, createdAt: state?.createdAt ?? this.#now() };
  }

  #stateFor(stream: string): StreamState {
    let state = this.#streams.get(stream);
    if (state === undefined) {
      state = { lifecycle: "ephemeral", completed: false, linked: false, createdAt: this.#now() };
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
  /**
   * Cadence (ms) of the defensive engine-reconcile pass (#661). Defaults to
   * {@link DEFAULT_ENGINE_RECONCILE_MS}. Clamped to Node's 32-bit timer ceiling; a non-positive /
   * non-finite value disables the pass (the terminal-lifecycle release path still runs).
   */
  readonly engineReconcileIntervalMs?: number;
  /** Called with the live service once mounted, so a driver can drive completion/reattach. */
  readonly onMounted?: (service: RelayTranscriptService) => void;
} = {}): AgenticFamily {
  let service: RelayTranscriptService | undefined;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let engineReconcileTimer: ReturnType<typeof setInterval> | undefined;
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
        // #689/#691: is the producing worker instance still live on ANY connection? Since #691 the
        // disconnect-driven reconcile decides completion by the engine job-state (below) whenever the
        // element-instance resolver is wired; this presence signal is the engine-LESS fallback that
        // spares a mid-job RECONNECT's still-active stream where no engine view is available. Read per
        // call for the same mount-order independence as the resolvers around it.
        isInstanceLive: (instance) => currentPresenceRegistry()?.isInstanceLive(instance) ?? false,
        // #485: resolve a completed job's worker attribution (presence identity/host) from the live
        // presence registry, read per call for the same mount-order independence. Absent → attribution
        // records instance only.
        attributionForInstance: (instance) => currentPresenceRegistry()?.attributionOf(instance),
        correlation: currentCorrelation,
        // #544: the advisory element-instance resolver the composition root closed over the engine.
        // Absent (engine-less host, or a test that mounts without it) → sessions are keyed on the
        // static element id only, exactly as before this slice.
        resolveElementInstance: ctx.resolveElementInstance,
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

      // Defensive engine-reconcile safety net (#661): periodically release any linked correlation
      // whose engine JOB park is gone but whose terminal `lifecycle` event never arrived (an unclean
      // worker exit), so a crashed worker's finished job stops showing as a phantom active job. Only
      // useful when an element-instance resolver is wired (engine read-model access); harmless no-op
      // otherwise. Advisory — a reconcile fault is logged, never thrown, and never keeps the process
      // alive on its own.
      if (ctx.resolveElementInstance !== undefined) {
        const reconcileInterval = engineReconcileMs(options.engineReconcileIntervalMs);
        if (reconcileInterval !== undefined) {
          // In-flight guard: `reconcileEngineCorrelations()` is async and awaits an engine read per
          // linked job, so a pass can outlast `reconcileInterval` (a small interval, or a slow/large
          // engine read-model). Without a guard, `setInterval` would fire overlapping passes that pile
          // up concurrent engine reads and log volume. {@link guardOverlappingPasses} skips a tick while
          // the previous pass is still running so only one reconcile runs at a time — the same "one pass
          // at a time" discipline the main poll loop enforces by self-scheduling.
          const reconcileTick = guardOverlappingPasses(() =>
            (service?.reconcileEngineCorrelations() ?? Promise.resolve()).catch((err: unknown) => {
              ctx.log.warn("agentic relay engine-reconcile failed", { err: String(err) });
            }),
          );
          engineReconcileTimer = setInterval(reconcileTick, reconcileInterval);
          engineReconcileTimer.unref?.();
        }
      }

      options.onMounted?.(service);
    },
    teardown(): void {
      if (sweepTimer !== undefined) {
        clearInterval(sweepTimer);
        sweepTimer = undefined;
      }
      if (engineReconcileTimer !== undefined) {
        clearInterval(engineReconcileTimer);
        engineReconcileTimer = undefined;
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
