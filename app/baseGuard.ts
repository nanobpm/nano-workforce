// Dead-end-base guard (#60).
//
// The merge stage was base-branch-blind: it ran `gh pr merge <n>` (or an enqueue) into whatever
// base the PR targeted, never checking that base. In a stacked-PR epic (the model of #49, where
// each decision PR stacks on the previous branch) a base branch can *itself* merge to the default
// branch. GitHub only auto-retargets an open PR when its base is DELETED on merge; a
// merged-but-undeleted base stays the target, `mergeStateStatus` reads CLEAN, and we would land
// the PR into a dead branch whose contents never reach the default branch.
//
// This module detects that case so the merge worker can escalate (retarget) instead of landing.

import { baseBranchLanded, fetchDefaultBranch, fetchPrBase } from "./github.ts";

/** The landing-target facts the dead-end decision is made from. */
export interface BaseTarget {
  /** The PR's current base branch. */
  base: string;
  /** The repo's default branch (e.g. `main`). */
  defaultBranch: string;
  /** Whether the base branch has already landed — see {@link baseBranchLanded}. */
  landed: "landed" | "open" | "unknown";
}

/** A base is a dead-end when it is **not** the default branch AND has already landed (a merged PR
 * exists from it). Ambiguity (`open` / `unknown`) is deliberately never a dead-end: the guard
 * blocks a merge only on a positive `landed` signal, so a legitimately-stacked PR whose base is
 * still open — or a base with no PR at all — is never wrongly held. A blank base or default is
 * unknown-safe → not a dead-end. */
export function isDeadEndBase(t: BaseTarget): boolean {
  if (!t.base || !t.defaultBranch) return false;
  if (t.base === t.defaultBranch) return false;
  return t.landed === "landed";
}

export interface BaseGuardResult {
  deadEnd: boolean;
  base: string;
  defaultBranch: string;
  landed: "landed" | "open" | "unknown";
}

/** Resolve a PR's landing target and decide whether it is a dead-end. Cheap for the common case:
 * a PR that targets the default branch short-circuits before the `baseBranchLanded` lookup. Best
 * effort — when a fact can't be resolved (no transport / GitHub hiccup) it returns `deadEnd:false`
 * so the guard never blocks a merge on ambiguity; the caller may `.catch()` a transport throw to
 * the same effect. */
export async function checkBaseTarget(
  repo: string,
  number: number | string,
  token: string,
): Promise<BaseGuardResult> {
  const [base, defaultBranch] = await Promise.all([
    fetchPrBase(repo, number, token),
    fetchDefaultBranch(repo, token),
  ]);
  if (!base || !defaultBranch || base === defaultBranch) {
    return { deadEnd: false, base: base ?? "", defaultBranch: defaultBranch ?? "", landed: "unknown" };
  }
  const landed = await baseBranchLanded(repo, base, token);
  const target: BaseTarget = { base, defaultBranch, landed };
  return { deadEnd: isDeadEndBase(target), base, defaultBranch, landed };
}
