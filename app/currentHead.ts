// The PR "current HEAD" reader shared by every step that must gate on the head the push landed —
// the capture-head / progress-check steps, the converge-gate's stale-review guard, AND the poller's
// stale-review re-solicitation (#799). It lives in this neutral module (not in a worker) so the
// poller in `app/service.ts` can reuse the EXACT reader the workers use without importing a worker
// (which would form a `service.ts ↔ worker` cycle) and without a second, drift-prone copy of the
// branch-ref-over-`head.sha` preference (#786).
import type { fetchBranchHead, fetchPrHead } from "./github.ts";

// Reads a PR's current head SHA. Injectable so unit tests never touch git/network; the default
// binds the real GitHub reader (the shared gh | token transport) and swallows any failure to
// `null` so the guard fails OPEN. It reads the BRANCH ref (`git/ref/heads/<branch>`) — updated
// atomically with the push — in preference to the PR object's asynchronously-denormalized
// `head.sha`, so a lagging PR projection can never fabricate a stale-but-valid no-advance
// escalation (#786). Once a head ref is known this trusts ONLY its atomic ref: a failed/absent
// ref read fails OPEN (`null`), never falling back to `head.sha`. The PR head is used only when
// the PR carries NO head ref at all.
export type HeadReader = (repo: string, prNumber: number) => Promise<string | null>;

/** Build the real head reader from the GitHub fetchers (injected so tests can stub them). Prefers
 * the branch ref (atomic with the push) over the PR object's denormalized `head.sha` (#786); fails
 * OPEN (`null`) on any unreadable state so a transport hiccup never fabricates a stale verdict. The
 * single canonical implementation — capture-head, progress-check, converge-gate, and the poller all
 * bind this so they gate on the same head. */
export function makeDefaultReadHead(deps: {
  fetchPrHead: typeof fetchPrHead;
  fetchBranchHead: typeof fetchBranchHead;
}): HeadReader {
  return async (repo, prNumber) => {
    const token = process.env.GITHUB_TOKEN ?? "";
    const pr = await deps.fetchPrHead(repo, prNumber, token).catch(() => null);
    if (!pr) return null;
    // Prefer the branch ref (atomic with the push) over the PR object's denormalized head.sha (#786).
    // Once the head branch is known, trust ONLY its atomic ref: a failed/absent ref read fails OPEN
    // (`null`) rather than falling back to the PR object's asynchronously-denormalized head.sha, which
    // can still report a stale-but-valid SHA after a push and fabricate a no-advance escalation — the
    // very projection this branch-ref read exists to avoid. The ref is read in the repository the
    // head branch actually lives in (the fork for a cross-repo PR — see below), so a fork PR fails
    // open safely instead of comparing an unrelated base-repo SHA. Fall back to the PR head only when
    // there is NO head ref.
    if (pr.headRef) {
      // Resolve the head ref in the repository the head branch actually lives in — the FORK for a
      // cross-repo PR (`pr.headRepo`), else the base `repo`. Querying the base repo unconditionally
      // would, for a fork PR whose head branch shares a name with a base-repo branch, read the
      // unrelated base-branch SHA and fabricate progress/no-progress (#786). When the head repo
      // cannot be resolved (a deleted fork ⇒ `headRepo:null`) fail OPEN to `null` rather than fall
      // back to the base repo and risk that collision.
      const headRepo = pr.headRepo;
      if (!headRepo) return null;
      return await deps.fetchBranchHead(headRepo, pr.headRef, token).catch(() => null);
    }
    return pr.headSha ?? null;
  };
}
