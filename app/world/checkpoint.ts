// nano-workforce — world checkpoint JOIN + RESTORE (issue #324, ADR 0062 Slice 4/5, the WORLD half).
//
// This is the orchestration that ties the durable store (./store.ts), the effect fence
// (./effect-ledger.ts) and the git inversion (./git.ts) into the two operations durable resume needs:
//
//  1. recordWorldCheckpoint — the JOIN. At each push the app records the world marker `{commitSha,
//     effects}` AND calls the mind's `session.checkpoint(commitSha, effectLedger)` (Slice 1) with the
//     SAME derived checkpoint, so mind + world commit at ONE turn boundary (the shared offset). This
//     closes the divergence failure: the harness can never think it hasn't pushed when the push
//     landed, or vice-versa, because a single derivation feeds both sides.
//
//  2. restoreWorld — the INVERSION. On a re-lease the round's outbound `git push` becomes an inbound
//     `git fetch && git checkout <commitSha>` that reconstructs the exact tree on a fresh worktree,
//     then the post-checkpoint effect tail is fence-replayed so an already-applied effect is skipped.
//     This runs BEFORE the harness mind is resumed (world first, then mind — the tree the replayed
//     conversation refers to must already exist).
import { type Effect, type FenceOutcome, fenceReplay } from "./effect-ledger.ts";
import type { GitRunner } from "./git.ts";
import type { WorldStore } from "./store.ts";

/**
 * The mind/world checkpoint contract shape (ADR 0062 §2). Slice 1 owns the harness-side
 * `session.checkpoint(commitSha, effectLedger)`; this is the one wire shape both halves derive from,
 * so the world marker recorded here and the mind checkpoint joined to it are the SAME object — a
 * single source of truth for the resume boundary.
 */
export interface SessionCheckpoint {
  /** The pushed SHA the working tree is reconstructed to on resume (the durable resume boundary). */
  readonly commitSha: string;
  /** The irreversible effects performed up to this checkpoint, each carrying its fence idempotency
   * key — replayed through the fence on restore so none is repeated. */
  readonly effectLedger: readonly Effect[];
}

/** The mind-side checkpoint sink — Slice 1's `session.checkpoint(...)`. `recordWorldCheckpoint` calls
 * it with the SAME `SessionCheckpoint` it persists, so the two halves never diverge. Optional so the
 * world half can be exercised (and land) before the mind backend is wired in. */
export type CheckpointSink = (checkpoint: SessionCheckpoint) => void | Promise<void>;

/** The inputs for a world checkpoint at a push. */
export interface WorldCheckpointInput {
  readonly prKey: string;
  readonly roundNo: number;
  readonly commitSha: string;
  /** The round's irreversible effects, in order. Defaults to a single `push` effect keyed by the
   * commit SHA. */
  readonly effects?: readonly Effect[];
}

/** The result of recording a world checkpoint: the shared offset (mind + world commit at it) and the
 * derived checkpoint both halves saw. */
export interface WorldCheckpointResult {
  readonly offset: number;
  readonly checkpoint: SessionCheckpoint;
}

/**
 * Record a world checkpoint at a push and JOIN it to the mind checkpoint. Derives ONE
 * {@link SessionCheckpoint} from the world marker, persists it in the durable store (allocating the
 * per-PR monotonic offset), and — when a `sink` is supplied — passes the SAME object to the mind's
 * `session.checkpoint`. Returning the offset lets a caller assert the mind and world committed at one
 * boundary (the divergence guard).
 */
export async function recordWorldCheckpoint(
  store: WorldStore,
  input: WorldCheckpointInput,
  sink?: CheckpointSink,
): Promise<WorldCheckpointResult> {
  const effects: readonly Effect[] = input.effects ?? [{ kind: "push", idempotencyKey: input.commitSha }];
  const checkpoint: SessionCheckpoint = { commitSha: input.commitSha, effectLedger: effects };
  const offset = await store.recordCheckpoint({
    prKey: input.prKey,
    roundNo: input.roundNo,
    commitSha: input.commitSha,
    effects,
  });
  // The JOIN: hand the mind the identical checkpoint the world just persisted, at the same boundary.
  // Advisory — a sink failure must not undo the durable world record (the world is authoritative for
  // the tree), so let it throw to the caller rather than swallowing a half-committed join here.
  if (sink) await sink(checkpoint);
  return { offset, checkpoint };
}

/** The outcome of a world restore: the checkpoint the tree was reconstructed to, plus which tail
 * effects were (re)applied vs. skipped by the fence. `null` when the PR has no push-checkpoint yet
 * (nothing to reconstruct). */
export interface WorldRestoreResult extends FenceOutcome {
  readonly offset: number;
  readonly commitSha: string;
}

/** Options for a world restore. */
export interface RestoreOptions {
  /** The remote to fetch the checkpoint SHA from (default `origin`). */
  readonly remote?: string;
  /** Runs a fenced tail effect (a `pr-comment`/`merge` that must be re-attempted because it did not
   * land before the crash). Omitted → tail effects are only fenced (never re-applied), which is the
   * safe default when the caller has no executor: an already-applied effect is skipped regardless. */
  readonly apply?: (effect: Effect) => void | Promise<void>;
}

/**
 * Restore the world on a re-lease by INVERTING the forward push: `git fetch` + `git checkout
 * <commitSha>` reconstructs the exact tree at the last push-checkpoint on the fresh worktree, then
 * the post-checkpoint effect tail is fence-replayed so an already-applied effect is SKIPPED, not
 * repeated. Returns the checkpoint restored to (or `null` when the PR never pushed).
 *
 * Call this BEFORE resuming the harness mind — the conversation being replayed refers to a tree that
 * must already exist.
 */
export async function restoreWorld(
  git: GitRunner,
  store: WorldStore,
  prKey: string,
  opts: RestoreOptions = {},
): Promise<WorldRestoreResult | null> {
  const last = await store.lastCheckpoint(prKey);
  if (!last) return null;
  // The inversion: the round pushed <commitSha> outbound; restore fetches it back and checks the
  // working tree out to it. Fetch first so the (possibly non-branch-tip) SHA is reachable locally.
  await git.fetch(opts.remote ?? "origin");
  await git.checkout(last.commitSha);
  // Fence-replay the effect tail: already-applied effects skip (idempotent — "no duplicate
  // push/comment"); a genuinely-pending effect is re-applied via `apply` (a no-op skip when none).
  const tail = await store.effectTail(prKey, last.offset);
  const fence = store.fenceFor(prKey, last.offset);
  const outcome = await fenceReplay(tail, fence, opts.apply ?? (() => {}));
  return { offset: last.offset, commitSha: last.commitSha, ...outcome };
}
