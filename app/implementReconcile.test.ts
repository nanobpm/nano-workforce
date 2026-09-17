// Red-first coverage for the implement-cell reconcile decision (issue #801) — the implement-stage twin
// of #796. The defect: an implement-step that returns NO machine-readable `status` but has an OPEN PR
// on its `feat/<task.id>` branch was dead-ended at a human escalation instead of adopting that PR and
// converging. These tests pin the canonical `ic_reconcile_gw` decision that reconciles from GitHub
// before escalating.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { HeadPr } from "./github.ts";
import {
  implementCellBranch,
  pickAdoptablePr,
  reconcileImplement,
  shouldReconcileImplement,
} from "./implementReconcile.ts";

const openPr = (number: number, base = "main"): HeadPr => ({
  number,
  url: `https://github.com/owner/repo/pull/${number}`,
  state: "open",
  baseRef: base,
});

test("implementCellBranch: the deterministic feat/<task.id> branch", () => {
  assertEquals(implementCellBranch("issue-796"), "feat/issue-796");
});

test("shouldReconcileImplement: only a blank/absent status reconciles", () => {
  assertEquals(shouldReconcileImplement(null), true);
  assertEquals(shouldReconcileImplement(undefined), true);
  assertEquals(shouldReconcileImplement("  "), true);
  assertEquals(shouldReconcileImplement("escalated"), false);
  assertEquals(shouldReconcileImplement("opened"), false);
});

test("pickAdoptablePr: the first OPEN PR wins; merged/closed are not adoptable", () => {
  assertEquals(pickAdoptablePr(null), null);
  assertEquals(pickAdoptablePr([]), null);
  assertEquals(pickAdoptablePr([{ ...openPr(1), state: "merged" }]), null);
  assertEquals(pickAdoptablePr([{ ...openPr(2), state: "closed" }, openPr(3)])?.number, 3);
});

// The core defect reproduction: blank status + an open PR on the branch → adopt & converge, no escalation.
test("reconcileImplement: blank status + open PR on feat/<task.id> → adopt (status=opened, pr set)", async () => {
  const calls: Array<{ repo: string; branch: string }> = [];
  const lookup = async (repo: string, branch: string): Promise<HeadPr[]> => {
    calls.push({ repo, branch });
    return [openPr(800)];
  };
  const res = await reconcileImplement(
    { status: null, subjectKey: "nanobpm/nano-workforce#796", taskId: "issue-796" },
    lookup,
    "token",
  );
  assertEquals(res, { reconciled: true, status: "opened", pr: "nanobpm/nano-workforce#800" });
  assertEquals(calls, [{ repo: "nanobpm/nano-workforce", branch: "feat/issue-796" }]);
});

test("reconcileImplement: blank status but NO branch/PR → escalate (unchanged behaviour)", async () => {
  const res = await reconcileImplement(
    { status: null, subjectKey: "owner/repo#7", taskId: "issue-7" },
    async () => [],
    "token",
  );
  assertEquals(res, { reconciled: false, status: null, pr: null });
});

test("reconcileImplement: a genuine escalation status is honoured, GitHub never consulted", async () => {
  let consulted = false;
  const res = await reconcileImplement(
    { status: "escalated", subjectKey: "owner/repo#7", taskId: "issue-7" },
    async () => {
      consulted = true;
      return [openPr(9)];
    },
    "token",
  );
  assertEquals(res, { reconciled: false, status: "escalated", pr: null });
  assertEquals(consulted, false);
});

test("reconcileImplement: only merged/closed PRs on the branch → escalate (nothing in-flight to adopt)", async () => {
  const res = await reconcileImplement(
    { status: null, subjectKey: "owner/repo#7", taskId: "issue-7" },
    async () => [{ ...openPr(5), state: "merged" }],
    "token",
  );
  assertEquals(res.reconciled, false);
});

test("reconcileImplement: a lookup transport failure falls through to escalate (best-effort)", async () => {
  const res = await reconcileImplement(
    { status: null, subjectKey: "owner/repo#7", taskId: "issue-7" },
    async () => {
      throw new Error("github 502");
    },
    "token",
  );
  assertEquals(res, { reconciled: false, status: null, pr: null });
});

test("reconcileImplement: an existing pr is carried through unchanged on fall-through (never wiped)", async () => {
  // A genuine escalation status → escalate; any pr already in scope must survive the re-emit.
  const escalated = await reconcileImplement(
    { status: "escalated", subjectKey: "owner/repo#7", taskId: "issue-7", pr: "owner/repo#42" },
    async () => [],
    "token",
  );
  assertEquals(escalated, { reconciled: false, status: "escalated", pr: "owner/repo#42" });

  // Blank status but no adoptable PR → escalate; an existing pr still survives.
  const noAdopt = await reconcileImplement(
    { status: null, subjectKey: "owner/repo#7", taskId: "issue-7", pr: "owner/repo#42" },
    async () => [],
    "token",
  );
  assertEquals(noAdopt, { reconciled: false, status: null, pr: "owner/repo#42" });
});

test("reconcileImplement: a successful adoption overwrites any existing pr with the adopted key", async () => {
  const res = await reconcileImplement(
    { status: null, subjectKey: "owner/repo#7", taskId: "issue-7", pr: "owner/repo#42" },
    async () => [openPr(99)],
    "token",
  );
  assertEquals(res, { reconciled: true, status: "opened", pr: "owner/repo#99" });
});

test("reconcileImplement: a missing taskId or unparseable subjectKey → escalate, no lookup", async () => {
  let consulted = false;
  const lookup = async (): Promise<HeadPr[]> => {
    consulted = true;
    return [openPr(1)];
  };
  assertEquals((await reconcileImplement({ status: null, subjectKey: "owner/repo#7", taskId: null }, lookup, "t")).reconciled, false);
  assertEquals((await reconcileImplement({ status: null, subjectKey: "not-a-key", taskId: "issue-7" }, lookup, "t")).reconciled, false);
  assertEquals(consulted, false);
});
