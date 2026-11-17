// Red-first coverage for the feature-run blocked reconcile decision (issue #967).
//
// The defect: a feature run whose agent reports `blocked` is trusted on its word even when the
// OBSERVABLE remote state contradicts it — the agent's `feat/<task.id>` branch was pushed and is
// ahead of base, and only the PR step is missing (feature run 742704: the branch sat pushed at the
// agent's own reported headSha while the run parked in the human inbox until an operator opened the
// PR by hand). Before routing to `feature-blocked`, the run must reconcile with the remote:
//
//   • branch pushed, ahead of base, an OPEN PR already on it → ADOPT that PR (`opened` + pr key);
//   • branch pushed, ahead of base, NO open PR → OPEN the (draft) PR from the branch, then converge;
//   • no commit to deliver (no branch, or the branch is not ahead of base) → escalate as today.
//
// These tests pin the canonical pure decision (`app/featureReconcile.ts`) the `pr.record-feature`
// worker consults before persisting a `blocked` outcome — a fake agent result that says "blocked"
// while the remote branch exists must resolve to `opened`, never to the operator inbox.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { HeadPr } from "./github.ts";
import {
  type BranchLookup,
  type ComparisonLookup,
  type PrCreator,
  reconcileBlockedFeature,
  shouldReconcileBlockedFeature,
} from "./featureReconcile.ts";

const openPr = (number: number, base = "main"): HeadPr => ({
  number,
  url: `https://github.com/owner/repo/pull/${number}`,
  state: "open",
  baseRef: base,
});

const BASE = { subjectKey: "owner/repo#7", taskId: "issue-7", baseBranch: "main" } as const;

/** A branch lookup that resolves `feat/issue-7` to `sha-feature` (and nothing else). */
const branchPushed: BranchLookup = async (_repo, branch) => (branch === "feat/issue-7" ? "sha-feature" : null);
const branchMissing: BranchLookup = async () => null;

/** A compare lookup reporting the head strictly ahead of base. */
const ahead: ComparisonLookup = async () => ({ status: "ahead", aheadBy: 2, behindBy: 0 });
const identical: ComparisonLookup = async () => ({ status: "identical", aheadBy: 0, behindBy: 0 });

const noPrs = async (): Promise<HeadPr[] | null> => [];
const createdPr: { number: number; url: string } = { number: 901, url: "https://github.com/owner/repo/pull/901" };
const createOk: PrCreator = async () => createdPr;

test("shouldReconcileBlockedFeature: ONLY a blocked outcome reconciles — every other status routes untouched", () => {
  assertEquals(shouldReconcileBlockedFeature("blocked"), true);
  assertEquals(shouldReconcileBlockedFeature("opened"), false);
  assertEquals(shouldReconcileBlockedFeature("skipped"), false);
  // A blank/absent status is the implement-CELL's reconcile surface (#801), not this one — the
  // feature parent never sees it (the cell adopts/escalates first), so it must not trigger here.
  assertEquals(shouldReconcileBlockedFeature(undefined), false);
  assertEquals(shouldReconcileBlockedFeature(null), false);
  assertEquals(shouldReconcileBlockedFeature(""), false);
  assertEquals(shouldReconcileBlockedFeature("escalated"), false);
});

test("blocked + branch pushed + an OPEN PR already on the branch → ADOPT it (the PR step was never the missing piece)", async () => {
  const res = await reconcileBlockedFeature(
    { ...BASE, status: "blocked" },
    { branch: branchPushed, compare: ahead, listPrs: async () => [openPr(555)] },
  );
  assertEquals(res, { featureStatus: "opened", prKey: "owner/repo#555" });
});

test("blocked + branch pushed and AHEAD of base + NO open PR → OPEN the PR from the branch (issue #967's exact case)", async () => {
  const created: { repo: string; head: string; base: string; draft: boolean }[] = [];
  const create: PrCreator = async (repo, head, base, _title, _body, draft) => {
    created.push({ repo, head, base, draft });
    return createdPr;
  };
  const res = await reconcileBlockedFeature(
    { ...BASE, status: "blocked" },
    { branch: branchPushed, compare: ahead, listPrs: noPrs, createPr: create },
  );
  assertEquals(res, { featureStatus: "opened", prKey: "owner/repo#901" });
  assertEquals(created.length, 1, "exactly one PR was opened");
  assertEquals(created[0].repo, "owner/repo");
  assertEquals(created[0].head, "feat/issue-7", "the PR is opened FROM the agent's deterministic branch");
  assertEquals(created[0].base, "main", "the PR targets the run's base branch");
  assertEquals(created[0].draft, true, "a reconcile-opened PR is a DRAFT (the agent never vouched for it)");
});

test("the agent's self-reported headSha is NOT trusted to gate delivery: a mismatch still opens the PR from the observable branch", async () => {
  // The observable remote state (branch exists, ahead of base) is the authority — the process checks
  // for itself rather than trusting the agent's word in EITHER direction. A stale/mismatched
  // self-report must never re-block a deliverable branch.
  const res = await reconcileBlockedFeature(
    { ...BASE, status: "blocked", headSha: "sha-stale-other" },
    { branch: branchPushed, compare: ahead, listPrs: noPrs, createPr: createOk },
  );
  assertEquals(res.featureStatus, "opened");
  assertEquals(res.prKey, "owner/repo#901");
});

test("a matching self-reported headSha also opens the PR (the reported case: branch at headSha, exitCode 0)", async () => {
  const res = await reconcileBlockedFeature(
    { ...BASE, status: "blocked", headSha: "sha-feature" },
    { branch: branchPushed, compare: ahead, listPrs: noPrs, createPr: createOk },
  );
  assertEquals(res.featureStatus, "opened");
  assertEquals(res.prKey, "owner/repo#901");
});

test("blocked + branch NOT pushed → escalate (no commit to deliver)", async () => {
  const res = await reconcileBlockedFeature(
    { ...BASE, status: "blocked" },
    { branch: branchMissing, compare: ahead, listPrs: noPrs, createPr: createOk },
  );
  assertEquals(res, { featureStatus: "blocked", prKey: null });
});

test("blocked + branch pushed but NOT ahead of base (identical) → escalate (no commit to deliver)", async () => {
  let creates = 0;
  const res = await reconcileBlockedFeature(
    { ...BASE, status: "blocked" },
    {
      branch: branchPushed,
      compare: identical,
      listPrs: noPrs,
      createPr: async () => {
        creates += 1;
        return createdPr;
      },
    },
  );
  assertEquals(res, { featureStatus: "blocked", prKey: null });
  assertEquals(creates, 0, "a branch with nothing over base never opens an empty PR");
});

test("an open PR targeting a DIFFERENT base is not adopted — but the pushed branch still delivers: open the PR on the run's base", async () => {
  const res = await reconcileBlockedFeature(
    { ...BASE, status: "blocked" },
    {
      branch: branchPushed,
      compare: ahead,
      listPrs: async () => [openPr(556, "epic/other")],
      createPr: createOk,
    },
  );
  assertEquals(res, { featureStatus: "opened", prKey: "owner/repo#901" });
});

test("a CLOSED PR on the branch is not adopted — the ahead branch opens a fresh PR", async () => {
  const closed: HeadPr = { ...openPr(557), state: "closed" };
  const res = await reconcileBlockedFeature(
    { ...BASE, status: "blocked" },
    { branch: branchPushed, compare: ahead, listPrs: async () => [closed], createPr: createOk },
  );
  assertEquals(res, { featureStatus: "opened", prKey: "owner/repo#901" });
});

test("an unusable transport (null listing / null branch read) escalates — never worse than today, never a blind PR", async () => {
  let creates = 0;
  const create: PrCreator = async () => {
    creates += 1;
    return createdPr;
  };
  const nullBranch = await reconcileBlockedFeature(
    { ...BASE, status: "blocked" },
    { branch: async () => null, compare: ahead, listPrs: noPrs, createPr: create },
  );
  assertEquals(nullBranch, { featureStatus: "blocked", prKey: null });

  const nullCompare = await reconcileBlockedFeature(
    { ...BASE, status: "blocked" },
    { branch: branchPushed, compare: async () => null, listPrs: noPrs, createPr: create },
  );
  assertEquals(nullCompare, { featureStatus: "blocked", prKey: null }, "an unknown ahead-ness never opens a maybe-empty PR");

  const nullListing = await reconcileBlockedFeature(
    { ...BASE, status: "blocked" },
    { branch: branchPushed, compare: ahead, listPrs: async () => null, createPr: create },
  );
  assertEquals(nullListing, { featureStatus: "blocked", prKey: null });
  assertEquals(creates, 0, "no transport ever opened a PR");
});

test("a failed GitHub read (throws) escalates — best-effort, the human decides as today", async () => {
  const res = await reconcileBlockedFeature(
    { ...BASE, status: "blocked" },
    {
      branch: async () => {
        throw new Error("github 502");
      },
      compare: ahead,
      listPrs: noPrs,
      createPr: createOk,
    },
  );
  assertEquals(res, { featureStatus: "blocked", prKey: null });
});

test("a failed PR CREATE escalates rather than recording an opened run with no PR", async () => {
  const res = await reconcileBlockedFeature(
    { ...BASE, status: "blocked" },
    {
      branch: branchPushed,
      compare: ahead,
      listPrs: noPrs,
      createPr: async () => {
        throw new Error("github 422");
      },
    },
  );
  assertEquals(res, { featureStatus: "blocked", prKey: null });
});

test("a null create (no transport at the write step) escalates", async () => {
  const res = await reconcileBlockedFeature(
    { ...BASE, status: "blocked" },
    { branch: branchPushed, compare: ahead, listPrs: noPrs, createPr: async () => null },
  );
  assertEquals(res, { featureStatus: "blocked", prKey: null });
});

test("missing routing inputs (no taskId / unparseable subjectKey) escalate untouched", async () => {
  const noTask = await reconcileBlockedFeature(
    { subjectKey: "owner/repo#7", taskId: undefined, baseBranch: "main", status: "blocked" },
    { branch: branchPushed, compare: ahead, listPrs: noPrs, createPr: createOk },
  );
  assertEquals(noTask, { featureStatus: "blocked", prKey: null });

  const badKey = await reconcileBlockedFeature(
    { subjectKey: "not-a-key", taskId: "issue-7", baseBranch: "main", status: "blocked" },
    { branch: branchPushed, compare: ahead, listPrs: noPrs, createPr: createOk },
  );
  assertEquals(badKey, { featureStatus: "blocked", prKey: null });
});

test("a non-blocked status passes through untouched without ANY GitHub read", async () => {
  let reads = 0;
  const res = await reconcileBlockedFeature(
    { ...BASE, status: "opened", pr: "owner/repo#44" },
    {
      branch: async () => {
        reads += 1;
        return null;
      },
      compare: ahead,
      listPrs: noPrs,
      createPr: createOk,
    },
  );
  assertEquals(res, { featureStatus: "opened", prKey: null }, "the caller's own routing is preserved (prKey resolution stays downstream)");
  assertEquals(reads, 0, "no reconcile lookup ran for a non-blocked outcome");
});

test("a `diverged`/`behind` comparison still delivers when the branch carries commits base lacks (aheadBy > 0)", async () => {
  // `compareCommits` three-dot semantics: a branch that has commits over the merge-base is
  // deliverable even when it also needs a rebase — the convergence loop owns green/mergeability, not
  // this gate. Only `aheadBy === 0` (identical/behind) means "no commit to deliver".
  const diverged: ComparisonLookup = async () => ({ status: "diverged", aheadBy: 1, behindBy: 3 });
  const res = await reconcileBlockedFeature(
    { ...BASE, status: "blocked" },
    { branch: branchPushed, compare: diverged, listPrs: noPrs, createPr: createOk },
  );
  assertEquals(res.featureStatus, "opened");
  assert(res.prKey === "owner/repo#901");
});
