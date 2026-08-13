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
import type { AgenticContext, AgenticFamily } from "../registry.ts";

/** The stable family name this slice registers under the seam (distinct from the wire family key). */
export const RELAY_FAMILY_NAME = "relay";

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

  constructor(options: RelayTranscriptServiceOptions) {
    this.#registry = options.registry;
    this.#log = options.log;
    this.store = options.db ? new TranscriptStore(options.db, options.transcript) : undefined;
    if (this.store && options.ensureSchema !== false) this.store.ensureSchema();

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
   * Declare a stream's retention lifecycle before (or independently of) its first `produce`. First
   * call wins in the store; here it also decides whether a producer disconnect auto-completes the
   * stream (`ephemeral`) or leaves it open for reattach (`long-lived`). No-op once the stream has
   * already been completed.
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
    const flushed = this.store.flush(stream, source, state.lifecycle);
    if (state.lifecycle === "ephemeral") state.completed = true;
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
    return this.store.flush(stream, source, "long-lived");
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
    return this.store?.sweep(now) ?? [];
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
    this.#stateFor(stream).producer = conn.id;
  }

  /**
   * Flush + complete every ephemeral stream whose producer connection is no longer live (the S1
   * registry dropped it on close or liveness timeout). Lazy, like the relay hub's own dead-subscriber
   * prune: it runs on each inbound frame, and shutdown covers the quiescent tail via {@link teardown}.
   */
  #reconcile(): void {
    for (const [stream, state] of this.#streams) {
      if (state.completed || state.lifecycle !== "ephemeral") continue;
      if (state.producer !== undefined && !this.#registry.has(state.producer)) {
        this.completeStream(stream);
      }
    }
  }

  #stateFor(stream: string): StreamState {
    let state = this.#streams.get(stream);
    if (state === undefined) {
      state = { lifecycle: "ephemeral", completed: false };
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
 */
export function createRelayFamily(options: {
  readonly relay?: RelayHubOptions;
  readonly transcript?: TranscriptStoreOptions;
  readonly ensureSchema?: boolean;
  /** Called with the live service once mounted, so a driver can drive completion/reattach. */
  readonly onMounted?: (service: RelayTranscriptService) => void;
} = {}): AgenticFamily {
  let service: RelayTranscriptService | undefined;
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
      });
      options.onMounted?.(service);
    },
    teardown(): void {
      service?.teardown();
      service = undefined;
    },
  };
}

/** The discovered family instance (the loader picks up this `family` export). */
export const family: AgenticFamily = createRelayFamily();

export default family;
