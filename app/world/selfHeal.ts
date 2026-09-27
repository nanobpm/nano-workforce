// No-advance self-heal (issue #818, the Layer 2 durable fix for the agent PR-head push-divergence
// class — jwulf/c8ctl-plugin-nano#270).
//
// The convergence loop escalates an `addressed` round whose PR head did NOT advance (see
// app/roundProgress.ts). But the round's work is often ALREADY pushed and reachable on the
// remote — just not on the PR head. A producer harness that provisions the review shape wrong cuts a
// throwaway `nano/agent-work/*` fallback branch and pushes the fix THERE, so the agent's "pushed"
// claim is true while the PR head never moves (this stranded nanobpm/nano-coder#26/#28, recovered by
// hand). Layer 1 (jwulf/c8ctl-plugin-nano#270) fixes the harness to push the PR head directly AND to
// report the pushed SHA as a `worldMarker`, which `pr.persist-round` records as a durable
// push-checkpoint (`world_checkpoints`). This module closes the loop: BEFORE escalating a no-advance
// round, reconcile that recorded checkpoint SHA against the PR head — if it is a STRICT
// fast-forward descendant of the head, advance the head onto it and continue the loop as real
// progress instead of parking a human.
//
// It keys off the recorded SHA (canonical world state), not any branch-naming convention, so it heals
// the whole class: any producer that leaves the round's work reachable-but-off-the-head. Every step
// fails SAFE — an absent checkpoint, an unreadable comparison, a non-fast-forward (diverged) tip, a
// cross-repo fork head, or a refused ref update all yield `{ healed: false }`, so the caller escalates
// exactly as it did before. It is purely additive to the existing no-advance path.

/** The push-checkpoint reader — the newest durable `{ commitSha }` recorded for a PR, or `null` when
 * the PR has none (nothing was pushed, so there is nothing to reconcile). Backed by
 * {@link ../world/store.ts}'s `WorldStore.lastCheckpoint`; injectable for tests. */
export type CheckpointReader = (prKey: string) => Promise<{ commitSha: string } | null>;

/** The PR-head reader — the head branch name + repo of a PR, so the self-heal knows WHICH ref to
 * advance and whether it lives in THIS repo (a fork head is unpushable from the base token). Backed
 * by `fetchPrHead`; injectable for tests. */
export type PrHeadReader = (
  repo: string,
  prNumber: number,
) => Promise<{ headRef: string | null; headRepo: string | null } | null>;

/** The ancestry comparator — proves the checkpoint SHA strictly fast-forward-descends the PR head.
 * Backed by `compareCommits`; injectable for tests. `null` means the comparison was unavailable. */
export type CommitComparator = (
  repo: string,
  base: string,
  head: string,
) => Promise<{ status: "ahead" | "behind" | "identical" | "diverged"; aheadBy: number; behindBy: number } | null>;

/** The fast-forward ref mover — advances the PR head branch to the checkpoint SHA. Backed by
 * `updateBranchRef` (a NON-force update, so GitHub itself refuses a non-fast-forward). Returns
 * `false` when the move was refused. Injectable for tests. */
export type HeadAdvancer = (repo: string, branch: string, sha: string) => Promise<boolean>;

export interface SelfHealDeps {
  readonly lastCheckpoint: CheckpointReader;
  readonly prHead: PrHeadReader;
  readonly compare: CommitComparator;
  readonly advanceHead: HeadAdvancer;
}

/** Why a no-advance round did or did not self-heal — `healed` drives the routing (continue vs.
 * escalate); `sha`/`reason` are for the operator log so a skipped heal is diagnosable. */
export interface SelfHealResult {
  readonly healed: boolean;
  /** The SHA the PR head was advanced to (only when `healed`). */
  readonly sha?: string;
  /** A short machine-readable reason a heal was skipped (only when NOT `healed`). */
  readonly reason?:
    | "no-checkpoint"
    | "already-at-head"
    | "no-head-ref"
    | "fork-head"
    | "compare-unavailable"
    | "not-fast-forward"
    | "advance-refused";
}

/** Attempt to self-heal a no-advance round by fast-forwarding the PR head onto a recorded
 * push-checkpoint SHA. Returns `{ healed: true, sha }` ONLY when a recorded checkpoint strictly
 * fast-forward-descends the current head AND the head was moved onto it; every other outcome is a
 * safe `{ healed: false, reason }` (→ the caller escalates). Never throws: a rejected promise from
 * any dep is caught and degrades to `{ healed: false }` so a transient GitHub/DB outage can never
 * fabricate a heal (or crash the guard).
 *
 * @param currentHead the PR head SHA the no-advance decision was made against (the compare base). It
 *   is non-null at the escalation point — a null/unreadable head fails OPEN upstream (continues) and
 *   never reaches here — so the comparison is always anchored on the real head. */
export async function attemptNoAdvanceSelfHeal(
  deps: SelfHealDeps,
  repo: string,
  prNumber: number,
  prKey: string,
  currentHead: string,
): Promise<SelfHealResult> {
  try {
    const checkpoint = await deps.lastCheckpoint(prKey);
    if (!checkpoint) return { healed: false, reason: "no-checkpoint" };
    const sha = checkpoint.commitSha;
    // The head is already at the checkpoint — nothing stranded, nothing to move. (A no-advance round
    // reaching here with head === checkpoint would be a benign no-op; treat it as "nothing to heal".)
    if (sha === currentHead) return { healed: false, reason: "already-at-head" };

    const head = await deps.prHead(repo, prNumber);
    const headRef = head?.headRef;
    if (!headRef) return { healed: false, reason: "no-head-ref" };
    // A fork-based PR's head branch lives in ANOTHER repo; the base-repo token cannot move it, so we
    // cannot self-heal it here — escalate instead of failing a cross-repo ref write.
    if (head.headRepo && head.headRepo !== repo) return { healed: false, reason: "fork-head" };

    // Prove the checkpoint STRICTLY fast-forward-descends the current head before moving anything: a
    // `behind`/`identical`/`diverged` checkpoint is NOT a safe fast-forward and must escalate. Anchor
    // the compare base on `currentHead` (the SHA the no-advance verdict used), not the branch name,
    // so a mid-check head move can't make us fast-forward onto the wrong baseline.
    const cmp = await deps.compare(repo, currentHead, sha);
    if (!cmp) return { healed: false, reason: "compare-unavailable" };
    if (cmp.status !== "ahead" || cmp.behindBy !== 0 || cmp.aheadBy <= 0) {
      return { healed: false, reason: "not-fast-forward" };
    }

    const advanced = await deps.advanceHead(repo, headRef, sha);
    if (!advanced) return { healed: false, reason: "advance-refused" };
    return { healed: true, sha };
  } catch {
    return { healed: false };
  }
}
