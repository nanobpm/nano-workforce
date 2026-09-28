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

/** The push-checkpoint reader — the newest durable `{ commitSha }` recorded by a SPECIFIC RUN of a PR
 * AT A SPECIFIC ROUND, or `null` when that run/round pushed nothing (so there is nothing to
 * reconcile). Scoped by the convergence RUN's `processKey` AND `roundNo` so a heal is anchored to THIS
 * attempt's own checkpoint and can never fast-forward the head onto a stale checkpoint from a prior
 * run — `round_no` alone does not identify a run, since a reopen resets `current_round` while the old
 * run's checkpoints survive (#819). Backed by {@link ../world/store.ts}'s
 * `WorldStore.lastCheckpointForRun`; injectable for tests. */
export type CheckpointReader = (
  prKey: string,
  processKey: string | null,
  roundNo: number,
) => Promise<{ commitSha: string } | null>;

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
 * `updateBranchRef` (a NON-force update, so GitHub itself refuses a non-fast-forward). The 4th
 * argument is the COMPARE-AND-SWAP precondition: the exact head SHA the fast-forward proof was
 * computed against (`currentHead`); the mover refuses (`false`) unless the ref still equals it at
 * mutation time, so a head advanced/replaced by a concurrent (superseded) run after the proof is
 * never PATCHed. Returns `false` when the move was refused (non-fast-forward OR lost CAS). Injectable
 * for tests. */
export type HeadAdvancer = (repo: string, branch: string, sha: string, expectedSha: string) => Promise<boolean>;

export interface SelfHealDeps {
  readonly lastCheckpoint: CheckpointReader;
  readonly prHead: PrHeadReader;
  readonly compare: CommitComparator;
  readonly advanceHead: HeadAdvancer;
  /** A LATE ownership guard, re-checked immediately BEFORE the (irreversible) ref mutation to close
   * the check-to-mutation TOCTOU (Copilot review on #819). The worker's pre-call `isSuperseded()`
   * read is not a fence across the async heal: after it returns, this function still awaits the
   * checkpoint lookup, PR-head read, and compare before `advanceHead`, and `submitPr` can install a
   * new `process_key` (a fresh run) in that window. Returns `true` while this run still owns the PR
   * row; when it returns `false` the heal is abandoned WITHOUT touching the ref, so a superseded
   * straggler can never PATCH the branch. Optional — omitted (or absent) means "assume ownership"
   * (the fail-open convention the worker's `isSuperseded` already uses when the identity is unknown),
   * so a caller with no supersession concept keeps the pure #818 behaviour. */
  readonly stillOwns?: () => Promise<boolean>;
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
    | "superseded"
    /** The ref move was refused: GitHub rejected the non-fast-forward, OR the compare-and-swap lost
     * (the head no longer equals the `currentHead` the fast-forward proof was validated against — a
     * concurrent run moved it). */
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
 *   never reaches here — so the comparison is always anchored on the real head.
 * @param roundNo the round being reconciled; the checkpoint lookup is scoped to it (and to
 *   `processKey`) so the heal can only fast-forward onto THIS run's own pushed SHA, never a stale
 *   prior-run/later-round one.
 * @param processKey the convergence RUN (process instance) reconciling the round. Scopes the
 *   checkpoint lookup to this run so a reopened PR (whose `current_round` reset to 1 while the prior
 *   run's checkpoints survive) can never select the old run's checkpoint (#819). */
export async function attemptNoAdvanceSelfHeal(
  deps: SelfHealDeps,
  repo: string,
  prNumber: number,
  prKey: string,
  currentHead: string,
  roundNo: number,
  processKey: string | null,
): Promise<SelfHealResult> {
  try {
    const checkpoint = await deps.lastCheckpoint(prKey, processKey, roundNo);
    if (!checkpoint) return { healed: false, reason: "no-checkpoint" };
    const sha = checkpoint.commitSha;
    // The head is already at the checkpoint — nothing stranded, nothing to move. (A no-advance round
    // reaching here with head === checkpoint would be a benign no-op; treat it as "nothing to heal".)
    if (sha === currentHead) return { healed: false, reason: "already-at-head" };

    const head = await deps.prHead(repo, prNumber);
    const headRef = head?.headRef;
    if (!headRef) return { healed: false, reason: "no-head-ref" };
    // Require a KNOWN, same-repo head before touching any ref. A fork-based PR's head branch lives in
    // ANOTHER repo, and an UNRESOLVABLE head repo (`headRepo == null`, e.g. a deleted fork) is equally
    // unhealable: `fetchPrHead` reports `null` when it cannot resolve the head's owner/name, yet
    // `headRef` can still be a same-named branch that also exists in the base repo. Treating `null` as
    // "in the base repo" would PATCH that unrelated base-repo branch, so classify any non-match (a real
    // fork OR an unresolved head) as an unhealable `fork-head` and escalate instead of risking a
    // cross-repo / wrong-branch ref write. Compare NORMALIZED (case-insensitive) identities: `parsePr`
    // preserves the caller's `owner/repo` spelling while GitHub returns the repo's canonical
    // `head.repo.full_name`, so a valid same-repo PR submitted as `Owner/Repo#7` would otherwise
    // mismatch the canonical `owner/repo`, be misclassified `fork-head`, and silently skip every
    // self-heal (Copilot review of #819). GitHub owner/repo names are case-insensitive, so lowercasing
    // both sides is the correct identity test while retaining the null rejection.
    if (head.headRepo == null || head.headRepo.toLowerCase() !== repo.toLowerCase()) {
      return { healed: false, reason: "fork-head" };
    }

    // Prove the checkpoint STRICTLY fast-forward-descends the current head before moving anything: a
    // `behind`/`identical`/`diverged` checkpoint is NOT a safe fast-forward and must escalate. Anchor
    // the compare base on `currentHead` (the SHA the no-advance verdict used), not the branch name,
    // so a mid-check head move can't make us fast-forward onto the wrong baseline.
    const cmp = await deps.compare(repo, currentHead, sha);
    if (!cmp) return { healed: false, reason: "compare-unavailable" };
    // Validate the compare COUNTS before trusting the fast-forward proof: a malformed compare
    // response can coerce `ahead_by`/`behind_by` to `NaN` (`Number("not-a-number")`), and because
    // `NaN <= 0` and `NaN !== 0` are BOTH false, a bare `aheadBy <= 0 || behindBy !== 0` gate would
    // let a `{status:"ahead", behindBy:0, aheadBy:NaN}` response slip through and PATCH the ref onto
    // an unproven SHA. Require finite INTEGER counts (a strict fast-forward is `behindBy === 0` AND
    // `aheadBy > 0`); any non-integer count is a corrupt proof and must escalate, not heal.
    if (
      cmp.status !== "ahead" ||
      !Number.isInteger(cmp.aheadBy) ||
      !Number.isInteger(cmp.behindBy) ||
      cmp.behindBy !== 0 ||
      cmp.aheadBy <= 0
    ) {
      return { healed: false, reason: "not-fast-forward" };
    }

    // LATE OWNERSHIP FENCE (Copilot review on #819). Everything above only READ GitHub/DB state; the
    // ONLY irreversible act is the ref move below. Two guards bind it to THIS run's validated state:
    // (1) the late `stillOwns()` re-check — right before the move — abandons a run that was superseded
    // DURING the awaits above (a concurrent `submitPr` installed a new `process_key`), instead of
    // moving the head and only then being discarded by the downstream `commit` fence (which guards the
    // DB write, not a ref mutation already made). Absent guard ⇒ assume ownership (the same fail-open
    // the worker's `isSuperseded` uses when identity is unknown). (2) the move itself is a
    // COMPARE-AND-SWAP keyed on `currentHead` — the exact base the fast-forward proof was computed
    // against — so the mutation's precondition is BOUND TO the validated state rather than trusted from
    // the separate `stillOwns()` read: a straggler that races past (1) still PATCHes nothing unless the
    // ref is verifiably still at `currentHead` at mutation time. GitHub exposes no server-side
    // expected-old-value precondition, so the CAS is the tightest fence the platform allows; the
    // non-force fast-forward invariant makes the bounded residual window fail-safe (head only ever
    // moves forward onto this run's own reachable checkpoint, never a rewrite).
    if (deps.stillOwns && !(await deps.stillOwns())) return { healed: false, reason: "superseded" };

    const advanced = await deps.advanceHead(repo, headRef, sha, currentHead);
    if (!advanced) return { healed: false, reason: "advance-refused" };
    return { healed: true, sha };
  } catch {
    return { healed: false };
  }
}
