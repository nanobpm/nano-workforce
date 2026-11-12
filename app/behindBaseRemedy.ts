// Behind-base remedy for failing required checks (issue #951).
//
// When a PR's required checks FAILED on a head that is BEHIND its base (e.g. CI infra was broken
// and has since been fixed on the base branch), the mechanical fix is to bring the branch up to
// date with its base — not to page a human or burn a fix-ci agent round on a defect that no longer
// exists. On a repo whose CI only runs on opened/ready/reopened (its merge protocol declares a
// `reopen`-capable `freshHeadRun`), the update's `synchronize` push produces no run, so the PR is
// also closed+reopened to produce a fresh head run. Attempted at most ONCE per head: the update
// moves the head, so a still-red, up-to-date head falls through to the existing fix-ci arm.
import { compareCommits, ensureFreshHeadRun, fetchPrBase, type PrState, updatePrBranch } from "./github.ts";
import type { MergeProtocol } from "./mergeProtocol.ts";

export interface BehindBaseDeps {
  readBase: (repo: string, number: number, token: string) => Promise<string | null>;
  compare: typeof compareCommits;
  updateBranch: typeof updatePrBranch;
  freshHeadRun: typeof ensureFreshHeadRun;
}

const realDeps: BehindBaseDeps = {
  readBase: fetchPrBase,
  compare: compareCommits,
  updateBranch: updatePrBranch,
  freshHeadRun: ensureFreshHeadRun,
};

/** Heads already remedied (`<repo>#<n>@<sha>`) — the once-per-head latch. In-process: a restart
 * may retry once more, which is harmless (an up-to-date head compares `behindBy: 0`). */
const attempted = new Set<string>();

/** Test-only: reset the once-per-head latch. */
export function _resetBehindBaseLatch(): void {
  attempted.clear();
}

/** Whether a protocol's fresh-head-run policy can close+reopen (CI only runs on reopen). */
function wantsReopen(protocol: MergeProtocol | null | undefined): boolean {
  return protocol?.freshHeadRun === "reopen" || protocol?.freshHeadRun === "ready-or-reopen";
}

/** If `st` has failing checks on a head that is behind its base, update the branch from base (and
 * reopen when the protocol needs it for a fresh run). Returns `true` when the branch was updated —
 * the caller should re-poll instead of dispatching fix-ci/escalating. Never throws. */
export async function maybeUpdateBehindBranch(
  repo: string,
  number: number,
  token: string,
  st: PrState,
  protocol: MergeProtocol | null | undefined,
  deps: BehindBaseDeps = realDeps,
): Promise<boolean> {
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
    if (wantsReopen(protocol)) await deps.freshHeadRun(repo, number, "reopen").catch(() => false);
    console.log(`[poller] failing checks on a head ${cmp.behindBy} behind '${base}' -> updated branch ${repo}#${number}`);
    return true;
  } catch {
    return false;
  }
}
