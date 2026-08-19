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
   */
  async recordCheckpoint(input: RecordCheckpointInput): Promise<number> {
    const { prKey, roundNo, commitSha } = input;
    const effects: readonly Effect[] = input.effects ?? [{ kind: "push", idempotencyKey: commitSha }];
    const applied = input.applied ?? true;
    const now = new Date().toISOString();
    return this.#data.open().tx(async (t) => {
      const checkpoints = t.table<WorldCheckpointRow>("world_checkpoints", "id");
      const effectsTable = t.table<WorldEffectRow>("world_effects", "id");
      const offset = await WorldStore.#nextOffsetOn(checkpoints, prKey);
      await checkpoints.insert({
        pr_key: prKey,
        round_no: roundNo,
        checkpoint_offset: offset,
        commit_sha: commitSha,
        created_at: now,
      });
      let seq = 0;
      for (const effect of effects) {
        await WorldStore.#appendEffect(effectsTable, prKey, offset, seq++, effect, applied, now);
      }
      return offset;
    });
  }

  /** Append one effect to the ledger via `effects`, skipping a re-record of an idempotency key already
   * present (the durable fence — the second record of one real effect is a no-op, not a second row).
   * Static so a transaction-scoped `Table` can be threaded in (see {@link recordCheckpoint}). */
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
    if (existing) return;
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
   * fence-replays after checking the working tree out to that checkpoint's SHA. */
  async effectTail(prKey: string, offset: number): Promise<Effect[]> {
    const rows = await this.#effects().find({ pr_key: prKey, checkpoint_offset: offset });
    return rows
      .sort((a, b) => a.seq - b.seq)
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
          if (row.applied !== 1) await effects.update(row.id, { applied: 1 });
          return;
        }
        await effects.insert({
          pr_key: prKey,
          checkpoint_offset: offset,
          seq: 0,
          kind: effect.kind,
          idempotency_key: effect.idempotencyKey,
          description: effect.description ?? null,
          applied: 1,
          created_at: new Date().toISOString(),
        });
      },
    };
  }
}
