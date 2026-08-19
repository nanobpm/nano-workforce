// nano-workforce — the durable world-checkpoint + effect-ledger store (issue #324, ADR 0062 Slice
// 4/5, the WORLD half). Backs the ./checkpoint.ts orchestration onto the app's SQLite DataLayer via
// the RAD `Table<T>` surface (`data.table(...)`) — NOT hand-written SQL — over the two tables added
// by `db/migrations/049_world_checkpoint.sql`.
//
// The store is the ONE canonical home of the world's durable resume state: the push-checkpoints
// (`world_checkpoints`, a per-PR monotonic offset → commit SHA) and the effect ledger + fence
// (`world_effects`). It exposes exactly what the forward path (record a checkpoint at a push) and the
// restore path (read the last checkpoint, fence-replay its effect tail) need — nothing derivable is
// duplicated (AGENTS.md "derivation over duplication": the tree is derived from `remote SHA +
// effect-tail`, never snapshot into a log).
import type { DataLayer, Table } from "@nanobpm/urban";
import { isUniqueConstraintFence } from "../dbFence.ts";
import type { Effect, EffectKind, Fence } from "./effect-ledger.ts";

/** A persisted push-checkpoint row (`world_checkpoints`). */
interface WorldCheckpointRow {
  id: number;
  pr_key: string;
  round_no: number;
  checkpoint_offset: number;
  commit_sha: string;
  created_at: string;
}

/** A persisted effect-ledger row (`world_effects`). */
interface WorldEffectRow {
  id: number;
  pr_key: string;
  checkpoint_offset: number;
  seq: number;
  kind: EffectKind;
  idempotency_key: string;
  description: string | null;
  applied: number;
  created_at: string;
}

/** The newest push-checkpoint for a PR — the durable resume boundary a replacement activation
 * reconstructs the working tree to. `offset` is the shared mind/world turn boundary. */
export interface LastCheckpoint {
  readonly offset: number;
  readonly commitSha: string;
  readonly roundNo: number;
}

/** The inputs recording a world checkpoint at a push: the pushed SHA plus the irreversible effects
 * that round performed (the push itself, any PR comment, any merge). */
export interface RecordCheckpointInput {
  readonly prKey: string;
  readonly roundNo: number;
  readonly commitSha: string;
  /** Irreversible effects performed this round, in the order they occurred. Defaults to a single
   * `push` effect keyed by the commit SHA when omitted. Each is recorded through the fence, so a
   * re-record of an already-known idempotency key is a no-op (never a second real effect). */
  readonly effects?: readonly Effect[];
  /** Whether the recorded effects have already been realised on the forward path (default `true` —
   * a checkpoint records what a round already DID). A pending tail effect (recorded before it is
   * performed, for crash-precise replay) is recorded with `applied: false`. */
  readonly applied?: boolean;
}

/** A durable store over the `world_checkpoints` + `world_effects` tables. */
export class WorldStore {
  readonly #data: DataLayer;

  constructor(data: DataLayer) {
    this.#data = data;
  }

  #checkpoints() {
    return this.#data.table<WorldCheckpointRow>("world_checkpoints", "id");
  }

  #effects() {
    return this.#data.table<WorldEffectRow>("world_effects", "id");
  }

  /** The next per-PR monotonic checkpoint offset (0 for the first, else `max + 1`). Derived from the
   * durable rows so it survives a process restart — the offset is never held in memory. */
  async nextOffset(prKey: string): Promise<number> {
    return WorldStore.#nextOffsetOn(this.#checkpoints(), prKey);
  }

  /** The next offset computed against a specific checkpoints `Table` handle — so it can be read on the
   * SAME transaction connection the checkpoint row is then inserted on (see {@link recordCheckpoint}),
   * keeping the allocate-then-insert atomic. */
  static async #nextOffsetOn(checkpoints: Table<WorldCheckpointRow>, prKey: string): Promise<number> {
    const rows = await checkpoints.find({ pr_key: prKey });
    if (rows.length === 0) return 0;
    return Math.max(...rows.map((r) => r.checkpoint_offset)) + 1;
  }

  /** The next intra-checkpoint `seq` for `{prKey, offset}` — `0` for a fresh offset, else `max + 1`.
   * When a re-record REUSES an existing offset (idempotent on the commit SHA), any newly-supplied
   * effect must be appended AFTER the tail already recorded there, not restart at `seq 0` and collide
   * with it. Read on the same transaction handle the effects are then appended on. */
  static async #nextSeqOn(effects: Table<WorldEffectRow>, prKey: string, offset: number): Promise<number> {
    const rows = await effects.find({ pr_key: prKey, checkpoint_offset: offset });
    if (rows.length === 0) return 0;
    return Math.max(...rows.map((r) => r.seq)) + 1;
  }

  /** True when `err` is the durable fence firing — a SQLite `UNIQUE constraint failed` raised because a
   * concurrent/duplicate writer inserted the row BETWEEN our `findOne` and our `insert`. Every insert
   * in this store guards a UNIQUE constraint (`UNIQUE(pr_key, commit_sha)` / `(pr_key, checkpoint_offset)`
   * on checkpoints, `UNIQUE(pr_key, idempotency_key)` on effects), so a check-then-insert is inherently
   * racy under the at-least-once persist-round delivery + a distributed fleet. Delegates to the ONE
   * canonical classifier ({@link isUniqueConstraintFence}) so this store, `abandonClosedPr`, and any
   * future fence site share a single implementation instead of each re-encoding the driver's error
   * shape (AGENTS.md: "no drift surfaces"). */
  static #isFenceCollision(err: unknown): boolean {
    return isUniqueConstraintFence(err);
  }

  /** Reconcile an existing ledger row's `applied` flag toward a LATER record's knowledge: flip a
   * still-pending row (`applied=0`) to realised (`applied=1`) once we know the effect has now landed
   * (`applied=true`). This is monotone — it NEVER un-applies a row (`1` never goes back to `0`) and
   * never marks a still-pending record applied — so a re-record can only ever advance the fence, not
   * retreat it. It is the ONE place a pending→applied transition is written, so the record path
   * (`#appendEffect`) and the replay path (`markApplied`) reconcile identically instead of each
   * re-encoding the flip (a drift surface). Without it, `#appendEffect`'s duplicate-key short-circuit
   * would leave a pending row pending forever even after the effect landed, so a later `restoreWorld`
   * would re-apply an already-executed side effect. */
  static async #reconcileApplied(
    effects: Table<WorldEffectRow>,
    row: WorldEffectRow,
    applied: boolean,
  ): Promise<void> {
    if (applied && row.applied !== 1) await effects.update(row.id, { applied: 1 });
  }

  /** Insert the checkpoint row for a not-yet-seen `{prKey, commitSha}`, allocating the next offset, and
   * tolerate the fence firing. `recordCheckpoint`'s `findOne`-then-insert is racy: a concurrent/duplicate
   * persist-round can insert the SAME SHA between our read and our write, so the insert hits
   * `UNIQUE(pr_key, commit_sha)`. Rather than surface it as a spurious job failure, re-read the winner's
   * row and REUSE its offset — the exact idempotent-on-SHA outcome the non-racing path yields. If the
   * collision was instead a pure offset race with a DIFFERENT SHA (`UNIQUE(pr_key, checkpoint_offset)`),
   * the SHA re-read misses and we rethrow, letting the job retry allocate a fresh offset. Returns the
   * offset the SHA is durably bound to. */
  static async #insertCheckpointFenced(
    checkpoints: Table<WorldCheckpointRow>,
    prKey: string,
    roundNo: number,
    commitSha: string,
    now: string,
  ): Promise<number> {
    const offset = await WorldStore.#nextOffsetOn(checkpoints, prKey);
    try {
      await checkpoints.insert({
        pr_key: prKey,
        round_no: roundNo,
        checkpoint_offset: offset,
        commit_sha: commitSha,
        created_at: now,
      });
      return offset;
    } catch (err) {
      if (!WorldStore.#isFenceCollision(err)) throw err;
      const raced = await checkpoints.findOne({ pr_key: prKey, commit_sha: commitSha });
      if (!raced) throw err;
      return raced.checkpoint_offset;
    }
  }

  /**
   * Record a push-checkpoint: allocate the next offset, persist `{commitSha}`, and append the round's
   * irreversible effects to the ledger (each fenced by `UNIQUE(pr_key, idempotency_key)`). Returns
   * the allocated offset — the SAME offset the mind's `session.checkpoint(...)` is joined to (see
   * ./checkpoint.ts), which is what keeps mind + world from diverging.
   *
   * ATOMIC: the checkpoint row and its whole effect ledger are written inside ONE transaction, so a
   * crash/error part-way can never leave a checkpoint whose fence is missing some/all of its ledger
   * rows — which would let a restore re-apply an effect that already landed. Any throw rolls the whole
   * write back (offset allocation included).
   *
   * Idempotent on the effect fence: an effect whose idempotency key is already in the ledger is not
   * re-inserted (so a duplicate record can never manufacture a second real effect). The checkpoint
   * row itself is guarded by `UNIQUE(pr_key, checkpoint_offset)`.
   *
   * Idempotent on the commit SHA: a re-record of the SAME `{prKey, commitSha}` (a retried/duplicate
   * persist-round job) REUSES the existing checkpoint's offset instead of allocating a fresh one.
   * Allocating a new offset would make a duplicate the newest `lastCheckpoint` while its effect tail
   * is empty (the global `(pr_key, idempotency_key)` fence skips the already-recorded effects), so a
   * later `restoreWorld` would read the empty tail and IGNORE genuinely-pending effects recorded on
   * the earlier offset — silent effect loss. Reusing the offset keeps the pending tail attached to
   * the surviving newest checkpoint; any newly-supplied effect is appended at that same offset.
   */
  async recordCheckpoint(input: RecordCheckpointInput): Promise<number> {
    const { prKey, roundNo, commitSha } = input;
    const effects: readonly Effect[] = input.effects ?? [{ kind: "push", idempotencyKey: commitSha }];
    const applied = input.applied ?? true;
    const now = new Date().toISOString();
    return this.#data.open().tx(async (t) => {
      const checkpoints = t.table<WorldCheckpointRow>("world_checkpoints", "id");
      const effectsTable = t.table<WorldEffectRow>("world_effects", "id");
      const existing = await checkpoints.findOne({ pr_key: prKey, commit_sha: commitSha });
      const offset = existing
        ? existing.checkpoint_offset
        : await WorldStore.#insertCheckpointFenced(checkpoints, prKey, roundNo, commitSha, now);
      let seq = await WorldStore.#nextSeqOn(effectsTable, prKey, offset);
      for (const effect of effects) {
        await WorldStore.#appendEffect(effectsTable, prKey, offset, seq++, effect, applied, now);
      }
      return offset;
    });
  }

  /** Append one effect to the ledger via `effects`, collapsing a re-record of an idempotency key
   * already present to the durable fence's no-op (the second record of one real effect is never a
   * second row). A re-record still RECONCILES the surviving row's `applied` flag: a tail effect first
   * recorded pending (`applied=false`) and later re-recorded once it landed (`applied=true`) must
   * advance the fence to realised, or a later `restoreWorld` would re-apply an already-executed side
   * effect. Static so a transaction-scoped `Table` can be threaded in (see {@link recordCheckpoint}). */
  static async #appendEffect(
    effects: Table<WorldEffectRow>,
    prKey: string,
    offset: number,
    seq: number,
    effect: Effect,
    applied: boolean,
    now: string,
  ): Promise<void> {
    const existing = await effects.findOne({ pr_key: prKey, idempotency_key: effect.idempotencyKey });
    if (existing) {
      await WorldStore.#reconcileApplied(effects, existing, applied);
      return;
    }
    try {
      await effects.insert({
        pr_key: prKey,
        checkpoint_offset: offset,
        seq,
        kind: effect.kind,
        idempotency_key: effect.idempotencyKey,
        description: effect.description ?? null,
        applied: applied ? 1 : 0,
        created_at: now,
      });
    } catch (err) {
      // A concurrent/duplicate writer recorded this idempotency key between our `findOne` and our
      // `insert` — the fence firing IS the intended outcome (one real effect → exactly one row), so
      // treat the collision as the same no-op the `existing` short-circuit above already is, not a
      // surfaced error that fails the persist-round. Still reconcile the raced row's `applied` flag,
      // exactly as the `existing` branch does, so a landed effect isn't left pending on the winner row.
      if (!WorldStore.#isFenceCollision(err)) throw err;
      const raced = await effects.findOne({ pr_key: prKey, idempotency_key: effect.idempotencyKey });
      if (raced) await WorldStore.#reconcileApplied(effects, raced, applied);
    }
  }

  /** The newest push-checkpoint for a PR, or `null` when the PR has none (nothing pushed yet, so
   * nothing to reconstruct — the caller keeps the freshly-provisioned worktree). */
  async lastCheckpoint(prKey: string): Promise<LastCheckpoint | null> {
    const rows = await this.#checkpoints().find({ pr_key: prKey });
    if (rows.length === 0) return null;
    const newest = rows.reduce((a, b) => (b.checkpoint_offset > a.checkpoint_offset ? b : a));
    return { offset: newest.checkpoint_offset, commitSha: newest.commit_sha, roundNo: newest.round_no };
  }

  /** The effect tail recorded at a checkpoint offset, in `seq` order — the sequence the restore path
   * fence-replays after checking the working tree out to that checkpoint's SHA. `seq` is the intended
   * order, but it is allocated by a racy read-max-plus-one (`#nextSeqOn`) and the schema has no
   * `UNIQUE(pr_key, checkpoint_offset, seq)`, so two concurrent inserts at one offset CAN land the same
   * `seq`. The monotonic autoincrement `id` breaks that tie so the tail is deterministic (a stable
   * insertion order) even under a `seq` collision — never a non-deterministic replay/audit order. */
  async effectTail(prKey: string, offset: number): Promise<Effect[]> {
    const rows = await this.#effects().find({ pr_key: prKey, checkpoint_offset: offset });
    return rows
      .sort((a, b) => a.seq - b.seq || a.id - b.id)
      .map((r) => ({
        kind: r.kind,
        idempotencyKey: r.idempotency_key,
        ...(r.description == null ? {} : { description: r.description }),
      }));
  }

  /** The durable {@link Fence} bound to a PR: `isApplied` is true once an effect's idempotency key is
   * in the ledger AND realised (`applied=1`); `markApplied` flips a pending effect to realised (or
   * records a newly-applied one). This is the seam `fenceReplay` folds a tail over. */
  fenceFor(prKey: string, offset: number): Fence {
    const effects = this.#effects();
    return {
      async isApplied(idempotencyKey: string): Promise<boolean> {
        const row = await effects.findOne({ pr_key: prKey, idempotency_key: idempotencyKey });
        return !!row && row.applied === 1;
      },
      async markApplied(effect: Effect): Promise<void> {
        const row = await effects.findOne({ pr_key: prKey, idempotency_key: effect.idempotencyKey });
        if (row) {
          await WorldStore.#reconcileApplied(effects, row, true);
          return;
        }
        try {
          await effects.insert({
            pr_key: prKey,
            checkpoint_offset: offset,
            // Append AFTER the tail already recorded at this offset — restarting at `seq 0` would
            // collide with a sibling effect at the same offset and make `effectTail`'s tie-sort
            // (`a.seq - b.seq`) non-deterministic, destabilising restore/audit ordering.
            seq: await WorldStore.#nextSeqOn(effects, prKey, offset),
            kind: effect.kind,
            idempotency_key: effect.idempotencyKey,
            description: effect.description ?? null,
            applied: 1,
            created_at: new Date().toISOString(),
          });
        } catch (err) {
          if (!WorldStore.#isFenceCollision(err)) throw err;
          // A concurrent restore/replay recorded this key between our `findOne` and our `insert`. The
          // desired end-state is simply "applied", which is already (or nearly) achieved — reconcile to
          // it by re-reading and flipping `applied`, rather than failing the restore over a fence we
          // WANTED to hold.
          const raced = await effects.findOne({ pr_key: prKey, idempotency_key: effect.idempotencyKey });
          if (raced) await WorldStore.#reconcileApplied(effects, raced, true);
        }
      },
    };
  }
}
