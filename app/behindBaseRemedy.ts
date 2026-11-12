// Behind-base remedy for failing required checks (issue #951).
//
// When a PR's required checks FAILED on a head that is BEHIND its base (e.g. CI infra was broken
// and has since been fixed on the base branch), the mechanical fix is to bring the branch up to
// date with its base — not to page a human or burn a fix-ci agent round on a defect that no longer
// exists. GitHub's update-branch is ASYNCHRONOUS (202 Accepted): the head only moves later. So an
// accepted update is tracked as PENDING and the old head is HELD (no fix-ci on its stale failures)
// until the poller observes the new head (or a bounded window lapses). The fresh-head CI run for a
// reopen-CI repo is then produced by the canonical frugal-CI remedy (`maybeEnsureFreshHeadRun`,
// once per head) when the NEW head reads as "no required run yet" — never by reopening the stale
// head here. Attempted at most ONCE per head: a still-red, up-to-date head falls through to fix-ci.
import { compareCommits, fetchPrBase, type PrState, updatePrBranch } from "./github.ts";
import type { MergeProtocol } from "./mergeProtocol.ts";

/** How long an accepted (async) update may leave the old head in place before we stop holding it. */
export const BEHIND_BASE_PENDING_MS = 10 * 60_000;

export interface BehindBaseDeps {
  readBase: (repo: string, number: number, token: string) => Promise<string | null>;
  compare: typeof compareCommits;
  updateBranch: typeof updatePrBranch;
  now: () => number;
}

const realDeps: BehindBaseDeps = {
  readBase: fetchPrBase,
  compare: compareCommits,
  updateBranch: updatePrBranch,
  now: () => Date.now(),
};

/** Heads already remedied (`<repo>#<n>@<sha>`) — the once-per-head latch. In-process: a restart
 * may retry once more, which is harmless (an up-to-date head compares `behindBy: 0`). */
const attempted = new Set<string>();

/** Accepted-but-not-yet-applied updates (`<repo>#<n>` → the old head + acceptance time). */
const pending = new Map<string, { oldHead: string; at: number }>();

/** Test-only: reset the once-per-head latch and pending updates. */
export function _resetBehindBaseLatch(): void {
  attempted.clear();
  pending.clear();
}

/** Is an accepted (async) update-branch still holding `headOid` as the old head? The merge-stall
 * probe reads this so it does not classify the old head's stale check failures as `blocked` (and
 * start fix-ci / escalate) while GitHub has accepted — but not yet applied — the branch update
 * (issue #951 review). Bounded by the same BEHIND_BASE_PENDING_MS window the remedy uses, so a
 * never-applied update stops holding once the window lapses. Pure read: never mutates the map. */
export function isBehindBaseUpdatePending(
  repo: string,
  number: number,
  headOid: string,
  now: () => number = () => Date.now(),
): boolean {
  const inflight = pending.get(`${repo}#${number}`);
  return inflight !== undefined && inflight.oldHead === headOid && now() - inflight.at < BEHIND_BASE_PENDING_MS;
}

/** If `st` has failing checks on a head that is behind its base, update the branch from base.
 * Returns `true` when an update was accepted OR is still pending on this (old) head — the caller
 * should re-poll instead of dispatching fix-ci/escalating. Never throws. `_protocol` is accepted for
 * call-site stability; the fresh-run nudge for the new head belongs to the frugal-CI remedy. */
export async function maybeUpdateBehindBranch(
  repo: string,
  number: number,
  token: string,
  st: PrState,
  _protocol: MergeProtocol | null | undefined,
  deps: BehindBaseDeps = realDeps,
): Promise<boolean> {
  const prId = `${repo}#${number}`;
  const inflight = pending.get(prId);
  if (inflight) {
    if (st.headRefOid === inflight.oldHead && deps.now() - inflight.at < BEHIND_BASE_PENDING_MS) return true;
    pending.delete(prId); // the head moved (update applied) or the window lapsed — judge afresh
  }
  if (st.failingChecks <= 0 || !st.headRefOid || st.state !== "open") return false;
  const latch = `${repo}#${number}@${st.headRefOid}`;
  if (attempted.has(latch)) return false;
  attempted.add(latch);
  try {
    const base = await deps.readBase(repo, number, token);
    if (!base) return false;
    const cmp = await deps.compare(repo, base, st.headRefOid, token);
    if (!cmp || cmp.behindBy <= 0) return false;
    const updated = await deps.updateBranch(repo, number, token, st.headRefOid);
    if (!updated) return false;
    pending.set(prId, { oldHead: st.headRefOid, at: deps.now() });
    console.log(`[poller] failing checks on a head ${cmp.behindBy} behind '${base}' -> update-branch accepted (pending new head) ${repo}#${number}`);
    return true;
  } catch {
    return false;
  }
}
