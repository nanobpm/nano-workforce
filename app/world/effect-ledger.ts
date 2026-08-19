// nano-workforce — the effect ledger + fence for durable agent-session resume (issue #324, ADR 0062
// Slice 4/5, the WORLD half).
//
// Durable resume reconstructs the git working tree by INVERTING the forward op: the round's outbound
// `git push` becomes an inbound `git fetch && git checkout <sha>` (see ./checkpoint.ts). But a round
// also performs OTHER irreversible actions that are NOT captured by the pushed tree — a PR comment, a
// `gh merge`. Replaying blindly on a resume would DUPLICATE them (a second identical review comment,
// a re-attempted merge). The fence stops that: every irreversible action is recorded in an EFFECT
// LEDGER with an idempotency key (the effect's natural identity — a commit SHA, a comment id, a merge
// key). On restore we replay the post-checkpoint effect tail THROUGH the fence, so an already-applied
// effect is SKIPPED, not repeated.
//
// This module is PURE (no I/O): the durable ledger lives in ./store.ts, the git inversion in
// ./git.ts, and the orchestration in ./checkpoint.ts. Keeping the fence a pure fold makes the
// "no duplicate effect on replay" invariant unit-testable without a database or a real git tree.

/** The classes of irreversible action the world-restore fence guards. Each maps to a natural
 * idempotency key: a `push` to its commit SHA, a `pr-comment` to the comment id, a `merge` to the
 * merge key. Anything reversible (a scratch file write reconstructed by the checkout) is NOT an
 * effect — only actions whose re-execution would be observable to the outside world belong here.
 *
 * The runtime tuple is the ONE canonical list (derivation over duplication): {@link EffectKind} is
 * derived from it, and a contract boundary that must validate an externally-supplied kind (e.g. the
 * `worldMarker` the harness reports) checks membership against it rather than re-listing the values. */
export const EFFECT_KINDS = ["push", "pr-comment", "merge"] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

/** True when `kind` is one of the known {@link EFFECT_KINDS}. The guard a contract boundary uses to
 * reject an unexpected effect kind before it enters the durable ledger. */
export function isEffectKind(kind: unknown): kind is EffectKind {
  return typeof kind === "string" && EFFECT_KINDS.some((k) => k === kind);
}

/** True when `sha` is a well-formed 40-hex git commit SHA (a full object name). The world-restore
 * marker's `commitSha` is used as an EXACT checkout target (`git fetch && git checkout <sha>`), so a
 * branch name, an abbreviated/short ref, or a whitespace-tainted value could reconstruct to a moved
 * branch tip or fail restore — undermining the "reconstruct the exact tree at <sha>" contract. Both
 * the EMIT boundary (`repoEnvelopeVars`) and the READ boundary (`worldMarkerOf`) validate through
 * this ONE canonical matcher so the two can never drift. */
export function isCommitSha(sha: unknown): sha is string {
  return typeof sha === "string" && /^[0-9a-f]{40}$/i.test(sha);
}

/** One irreversible action in the effect ledger. `idempotencyKey` is the effect's natural identity —
 * the value that makes "did this already happen?" answerable WITHOUT re-doing it. Two ledger entries
 * with the same key denote the same real-world effect, so the fence collapses them to one. */
export interface Effect {
  readonly kind: EffectKind;
  /** The effect's natural, stable identity (commit SHA / comment id / merge key). The fence key. */
  readonly idempotencyKey: string;
  /** A human audit note (optional) — never load-bearing for fence identity. */
  readonly description?: string;
}

/** The durable fence seam the replay folds over. `isApplied` answers "has this effect's idempotency
 * key already landed?" from the ledger; `markApplied` records that an effect has now been realised so
 * a LATER resume skips it too. Both are async so a real SQLite-backed ledger (./store.ts) satisfies
 * them, while an in-memory `Set` satisfies them in tests. */
export interface Fence {
  isApplied(idempotencyKey: string): boolean | Promise<boolean>;
  markApplied(effect: Effect): void | Promise<void>;
}

/** The breakdown of a fenced replay: which tail effects were (re)applied and which the fence skipped
 * because they had already landed. `skipped` being the whole already-applied prefix is what makes a
 * resume idempotent — the acceptance criterion "no duplicate push/comment (fence holds)". */
export interface FenceOutcome {
  readonly applied: Effect[];
  readonly skipped: Effect[];
}

/**
 * Replay an ordered effect tail through the fence: for each effect IN ORDER, if the fence already
 * has its idempotency key it is skipped (never re-applied); otherwise `apply` runs the real side
 * effect and the fence records it as applied so no later resume repeats it.
 *
 * The ordering is load-bearing — effects must replay in the sequence they were recorded (a comment
 * that references a push must not run before it) — so this is a strict left-fold, never a parallel
 * map. `apply` is invoked ONLY for genuinely-missing effects, which is the whole point: a replacement
 * activation that crashed AFTER a push but BEFORE its trailing comment replays only the comment.
 */
export async function fenceReplay(
  effects: readonly Effect[],
  fence: Fence,
  apply: (effect: Effect) => void | Promise<void>,
): Promise<FenceOutcome> {
  const applied: Effect[] = [];
  const skipped: Effect[] = [];
  const seenThisReplay = new Set<string>();
  for (const effect of effects) {
    // Guard against a duplicate key WITHIN this tail too (a malformed ledger), not just against the
    // durable fence — two entries with one key are one effect, so the second is always a skip.
    if (seenThisReplay.has(effect.idempotencyKey) || (await fence.isApplied(effect.idempotencyKey))) {
      skipped.push(effect);
      continue;
    }
    await apply(effect);
    await fence.markApplied(effect);
    seenThisReplay.add(effect.idempotencyKey);
    applied.push(effect);
  }
  return { applied, skipped };
}
