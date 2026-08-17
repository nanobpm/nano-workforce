// nano-workforce — replay-by-reseed / fork of a transcript log (ADR 0056, #251).
//
// The H3 read path (#222) can RESUME the same stream from an offset (reattach parity), but it cannot
// FORK: seed a NEW stream from an existing log so an exited agent's session can be branched or re-run
// from a chosen point ("what-if" a different continuation). dsh gets this for free because a session IS
// its append-only log, so forking is just re-seeding a new session from an existing log up to offset N.
// This module gives the transcript store the same capability WITHOUT touching the store package: it
// reads the source log and re-records it into a fresh stream through the store's own idempotent,
// offset-keyed {@link TranscriptStore.record} — so the fork is itself append-only and offset-parity
// with its source, and replays through the SAME resume-from-offset read path a native stream uses.
//
// Invariants preserved (ADR 0056): app-tier only, append-only (we only ever `record`, never mutate),
// advisory (a fork is a new advisory transcript — it gates no BPMN flow), and offset/resume wire-shape
// parity (the fork keeps the source offsets, so a reattach behaves identically on the branch).

import type { TranscriptChunk, TranscriptLifecycle, TranscriptStore, TranscriptStream } from "@nanobpm/agentic/transcript";

/** Raised when a fork/reseed cannot proceed — the source is missing, or the target already exists. */
export class TranscriptForkError extends Error {
  readonly source: string;
  readonly target: string;
  constructor(source: string, target: string, message: string) {
    super(message);
    this.name = "TranscriptForkError";
    this.source = source;
    this.target = target;
  }
}

/** Options controlling how a source log is reseeded into a new stream. */
export interface ForkTranscriptOptions {
  /**
   * Seed only chunks with `offset <= throughOffset` (inclusive) — the point the branch diverges from.
   * Omit to fork the WHOLE source log (every retained chunk). A `throughOffset` below the source's
   * oldest retained offset yields an empty fork (a valid, if trivial, branch point).
   */
  readonly throughOffset?: number;
  /**
   * The forked stream's retention lifecycle. Defaults to `ephemeral` — a fork is a captured branch,
   * retained-whole then swept like any completed session, not a growing live stream.
   */
  readonly lifecycle?: TranscriptLifecycle;
  /**
   * Allow reseeding into a target that already exists. Off by default: forking onto a populated stream
   * would interleave two logs' bytes and defeat offset-parity, so we refuse rather than clobber. When
   * on, seeding is still idempotent (offset-keyed), so re-running the SAME fork is a safe no-op — but
   * the existing target must already hold exactly this seed prefix (same offsets, same chunk bytes,
   * same lifecycle); a target that diverges from the prefix throws rather than silently interleaving.
   */
  readonly allowExisting?: boolean;
}

/** The outcome of a {@link forkTranscript}: the new stream, how many chunks it seeded, and its window. */
export interface ForkResult {
  /** The forked stream id (the `target` argument). */
  readonly stream: string;
  /** The source stream the fork was seeded from. */
  readonly source: string;
  /** Number of chunks newly persisted into the fork. */
  readonly seeded: number;
  /** The highest source offset included in the fork (undefined when the fork is empty). */
  readonly throughOffset?: number;
  /** The forked stream's metadata after seeding. */
  readonly meta: TranscriptStream;
}

/**
 * Fork a transcript: seed a NEW stream (`target`) from an existing log (`source`) up to a chosen offset,
 * so an exited session can be branched and replayed independently.
 *
 * The fork keeps the SOURCE offsets (offset-parity), so it resumes through the identical
 * resume-from-offset read path a native stream uses. It reads the source's retained window
 * (`store.read`), takes the prefix at or below `throughOffset` (default: the whole log), and re-records
 * it into `target` via the store's idempotent offset-keyed `record` — so the operation is append-only
 * and safe to re-run. The branch is fully independent of its source thereafter: appending to either
 * stream never affects the other.
 *
 * Throws {@link TranscriptForkError} when the source has no transcript, when the target already
 * exists and `allowExisting` is not set, or when `allowExisting` is set but the existing target does
 * not already match the reseed prefix exactly (divergent chunk bytes/offsets or a different lifecycle).
 */
export function forkTranscript(
  store: TranscriptStore,
  source: string,
  target: string,
  options: ForkTranscriptOptions = {},
): ForkResult {
  if (source === target) {
    throw new TranscriptForkError(source, target, "cannot fork a stream onto itself");
  }
  if (store.get(source) === undefined) {
    throw new TranscriptForkError(source, target, `source stream "${source}" has no transcript to fork`);
  }
  const existing = store.get(target);
  if (existing !== undefined && !options.allowExisting) {
    throw new TranscriptForkError(source, target, `target stream "${target}" already exists (pass allowExisting to reseed it)`);
  }

  const lifecycle: TranscriptLifecycle = options.lifecycle ?? "ephemeral";
  const through = options.throughOffset;
  const chunks: TranscriptChunk[] = store
    .read(source)
    .filter((c) => through === undefined || c.offset <= through);

  // Reseeding onto an EXISTING target (allowExisting) is only safe when that target already holds
  // exactly the prefix we are about to seed. `record()` is offset-keyed and idempotent, so it silently
  // no-ops any offset already present — if the existing chunk at that offset differs (or the target
  // carries offsets outside this prefix, or a different lifecycle), the reseed would leave a stream
  // that is a MIXTURE of the prior data and the seed, breaking the documented offset-parity invariant.
  // Validate the overlap before writing and refuse rather than clobber/interleave.
  if (existing !== undefined) {
    if (existing.lifecycle !== lifecycle) {
      throw new TranscriptForkError(
        source,
        target,
        `target stream "${target}" already exists with lifecycle "${existing.lifecycle}", cannot reseed as "${lifecycle}"`,
      );
    }
    const seedByOffset = new Map(chunks.map((c) => [c.offset, c.chunk]));
    for (const c of store.read(target)) {
      const expected = seedByOffset.get(c.offset);
      if (expected === undefined || expected !== c.chunk) {
        throw new TranscriptForkError(
          source,
          target,
          `target stream "${target}" already contains data that does not match the reseed prefix at offset ${c.offset}; refusing to interleave`,
        );
      }
    }
  }

  // Open the fork explicitly so an empty fork (throughOffset predating the log) is still a real,
  // listed stream under its own lifecycle rather than a phantom — mirrors the store's open-then-record.
  store.open(target, lifecycle);
  const seeded = chunks.length > 0 ? store.record(target, chunks, lifecycle) : 0;

  const meta = store.get(target);
  if (meta === undefined) {
    // Defensive: open() above guarantees a row, so this only fires on a store contract breach.
    throw new TranscriptForkError(source, target, `fork of "${source}" into "${target}" did not persist a stream`);
  }

  const result: ForkResult = {
    stream: target,
    source,
    seeded,
    meta,
  };
  const last = chunks.at(-1);
  return last !== undefined ? { ...result, throughOffset: last.offset } : result;
}
