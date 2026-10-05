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
  retryNudgeFor,
  shouldReconcileImplement,
} from "./implementReconcile.ts";

const openPr = (number: number, base = "main"): HeadPr => ({
  number,
  url: `https://github.com/owner/repo/pull/${number}`,
  state: "open",
  baseRef: base,
});

// The non-adopt, non-retry tail every escalate/adopt assertion carries (issue #865 widened the result
// shape with the auto-retry fields; #865 review added `deliveryVerified`). Spread it into each expected
// object so the tests stay focused on the reconcile/pr decision. `deliveryVerified: false` is the
// fall-through default (no lookup ran / it threw / transport unavailable); the adopt and
// verified-absence cases override it to `true`.
const tail = { retry: false, retryNudge: null, retried: false, deliveryVerified: false } as const;
// The tail for a SUCCESSFUL lookup: delivery state was confirmed (an adoptable PR, or a verified
// absence), so `deliveryVerified` is `true`.
const verified = { ...tail, deliveryVerified: true } as const;

test("implementCellBranch: the deterministic feat/<task.id> branch", () => {
  assertEquals(implementCellBranch("issue-796"), "feat/issue-796");
});

test("shouldReconcileImplement: blank or a claimed-completion (off-vocabulary) status reconciles; a recognised status or an answerable question does not", () => {
  assertEquals(shouldReconcileImplement(null), true);
  assertEquals(shouldReconcileImplement(undefined), true);
  assertEquals(shouldReconcileImplement("  "), true);
  // Off-vocabulary "claimed completion" (issue #865) — look for a delivered PR before escalating.
  assertEquals(shouldReconcileImplement("completed"), true);
  assertEquals(shouldReconcileImplement("done"), true);
  // Recognised statuses are the agent's own clean terminal / escalation — never auto-reconciled.
  assertEquals(shouldReconcileImplement("escalated"), false);
  assertEquals(shouldReconcileImplement("opened"), false);
  assertEquals(shouldReconcileImplement("blocked"), false);
  assertEquals(shouldReconcileImplement("skipped"), false);
  // An off-vocabulary status carrying an answerable question is a GENUINE escalation — honour it.
  assertEquals(shouldReconcileImplement("completed", "Which API should I use?"), false);
});

test("pickAdoptablePr: the first OPEN PR wins; merged/closed are not adoptable", () => {
  assertEquals(pickAdoptablePr(null), null);
  assertEquals(pickAdoptablePr([]), null);
  assertEquals(pickAdoptablePr([{ ...openPr(1), state: "merged" }]), null);
  assertEquals(pickAdoptablePr([{ ...openPr(2), state: "closed" }, openPr(3)])?.number, 3);
});

test("pickAdoptablePr: a known baseBranch adopts only an open PR that targets it", () => {
  // Multiple open PRs from the same head branch to different bases — only the one matching the
  // run's pinned base is adoptable; a stale/wrong-base PR (even if first) is never adopted.
  const prs = [openPr(10, "old-epic-base"), openPr(11, "epic/feat-x")];
  assertEquals(pickAdoptablePr(prs, "epic/feat-x")?.number, 11);
  // No open PR targets the pinned base → nothing adoptable (escalate rather than converge the wrong PR).
  assertEquals(pickAdoptablePr([openPr(12, "some-other-base")], "epic/feat-x"), null);
  // Whitespace-only base is treated as "unknown" → first-open fallback.
  assertEquals(pickAdoptablePr([openPr(13, "main")], "  ")?.number, 13);
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
  assertEquals(res, { reconciled: true, status: "opened", pr: "nanobpm/nano-workforce#800", ...verified });
  assertEquals(calls, [{ repo: "nanobpm/nano-workforce", branch: "feat/issue-796" }]);
});

test("reconcileImplement: blank status but NO branch/PR → escalate (unchanged behaviour)", async () => {
  const res = await reconcileImplement(
    { status: null, subjectKey: "owner/repo#7", taskId: "issue-7" },
    async () => [],
    "token",
  );
  assertEquals(res, { reconciled: false, status: null, pr: null, ...verified });
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
  assertEquals(res, { reconciled: false, status: "escalated", pr: null, ...tail });
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
  assertEquals(res, { reconciled: false, status: null, pr: null, ...tail });
});

test("reconcileImplement: an existing pr is carried through unchanged on fall-through (never wiped)", async () => {
  // A genuine escalation status → escalate; any pr already in scope must survive the re-emit.
  const escalated = await reconcileImplement(
    { status: "escalated", subjectKey: "owner/repo#7", taskId: "issue-7", pr: "owner/repo#42" },
    async () => [],
    "token",
  );
  assertEquals(escalated, { reconciled: false, status: "escalated", pr: "owner/repo#42", ...tail });

  // Blank status but no adoptable PR → escalate; an existing pr still survives.
  const noAdopt = await reconcileImplement(
    { status: null, subjectKey: "owner/repo#7", taskId: "issue-7", pr: "owner/repo#42" },
    async () => [],
    "token",
  );
  assertEquals(noAdopt, { reconciled: false, status: null, pr: "owner/repo#42", ...verified });
});

test("reconcileImplement: a successful adoption overwrites any existing pr with the adopted key", async () => {
  const res = await reconcileImplement(
    { status: null, subjectKey: "owner/repo#7", taskId: "issue-7", pr: "owner/repo#42" },
    async () => [openPr(99)],
    "token",
  );
  assertEquals(res, { reconciled: true, status: "opened", pr: "owner/repo#99", ...verified });
});

test("reconcileImplement: with a pinned baseBranch, only a PR targeting it is adopted", async () => {
  // The head branch carries two open PRs to different bases — adopt the one matching the run's base.
  const adopt = await reconcileImplement(
    { status: null, subjectKey: "owner/repo#7", taskId: "issue-7", baseBranch: "epic/feat-x" },
    async () => [openPr(50, "stale-base"), openPr(51, "epic/feat-x")],
    "token",
  );
  assertEquals(adopt, { reconciled: true, status: "opened", pr: "owner/repo#51", ...verified });

  // Only a wrong-base PR exists → escalate rather than converge the wrong branch. The lookup SUCCEEDED
  // and confirmed no PR targets the pinned base — a verified absence.
  const escalate = await reconcileImplement(
    { status: null, subjectKey: "owner/repo#7", taskId: "issue-7", baseBranch: "epic/feat-x", pr: "owner/repo#42" },
    async () => [openPr(52, "stale-base")],
    "token",
  );
  assertEquals(escalate, { reconciled: false, status: null, pr: "owner/repo#42", ...verified });
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

// Issue #865 — a claimed-completion status (an off-vocabulary `completed`) is no longer dead-ended at a
// false "no result" escalation: it reconciles from GitHub (adopting a delivered PR), and when none
// exists it is auto-retried ONCE before escalating.
test("reconcileImplement: claimed-completion status + an open PR on the branch → adopt (status=opened)", async () => {
  const calls: Array<{ repo: string; branch: string }> = [];
  const res = await reconcileImplement(
    { status: "completed", subjectKey: "owner/repo#41", taskId: "issue-41" },
    async (repo, branch) => {
      calls.push({ repo, branch });
      return [openPr(900)];
    },
    "token",
  );
  assertEquals(res, { reconciled: true, status: "opened", pr: "owner/repo#900", retry: false, retryNudge: null, retried: false, deliveryVerified: true });
  assertEquals(calls, [{ repo: "owner/repo", branch: "feat/issue-41" }]);
});

test("reconcileImplement: claimed-completion + NO PR + not yet retried → auto-retry once with a nudge", async () => {
  const res = await reconcileImplement(
    { status: "completed", subjectKey: "owner/repo#41", taskId: "issue-41" },
    async () => [],
    "token",
  );
  assertEquals(res.reconciled, false);
  assertEquals(res.retry, true);
  assertEquals(res.retried, true);
  assertEquals(res.status, "completed");
  assertEquals(typeof res.retryNudge === "string" && res.retryNudge.includes("completed"), true);
});

// Issue #865 review ("previously missed"): the retry nudge must not over-assert "pushed NO branch, so
// your work was discarded" — it also fires when an open PR merely targets the WRONG base (a verified
// absence ON THIS BASE), where the pushed work was NOT discarded. The nudge must describe the missing
// ADOPTABLE PR and tell the agent to recover pushed work / retarget an existing PR (feature.md resume
// guidance), not claim the work is gone.
test("retryNudgeFor: describes the missing ADOPTABLE PR and points at recovery/retarget, never a false 'work was discarded' (#865 review)", () => {
  const nudge = retryNudgeFor("completed");
  // It names the reported status.
  assertEquals(nudge.includes('"completed"'), true);
  // It does NOT over-assert that no branch was pushed / the work was discarded.
  assertEquals(nudge.includes("your work was discarded"), false);
  assertEquals(nudge.includes("pushed NO branch"), false);
  // It describes the missing adoptable PR (none adoptable on the run's base) and the recovery path:
  // recover an already-pushed branch / retarget an existing PR (consistent with feature.md resume).
  assertEquals(nudge.includes("no adoptable pull request"), true);
  assertEquals(/recover|retarget/i.test(nudge), true);
});

test("reconcileImplement: claimed-completion + NO PR but ALREADY retried → escalate (retry is bounded once)", async () => {
  const res = await reconcileImplement(
    { status: "completed", subjectKey: "owner/repo#41", taskId: "issue-41", retried: true },
    async () => [],
    "token",
  );
  assertEquals(res, { reconciled: false, status: "completed", pr: null, retry: false, retryNudge: null, retried: true, deliveryVerified: true });
});

test("reconcileImplement: claimed-completion carrying an answerable question → escalate, no lookup, no retry", async () => {
  let consulted = false;
  const res = await reconcileImplement(
    { status: "completed", subjectKey: "owner/repo#41", taskId: "issue-41", question: "Which design?" },
    async () => {
      consulted = true;
      return [];
    },
    "token",
  );
  assertEquals(res, { reconciled: false, status: "completed", pr: null, retry: false, retryNudge: null, retried: false, deliveryVerified: false });
  assertEquals(consulted, false);
});

test("reconcileImplement: a true no-result (blank status) with no PR escalates — it is NOT auto-retried", async () => {
  const res = await reconcileImplement(
    { status: null, subjectKey: "owner/repo#7", taskId: "issue-7" },
    async () => [],
    "token",
  );
  assertEquals(res.retry, false);
});

// Issue #865 review — a non-affirmative off-vocabulary status (a reported failure / input-required /
// unknown) is NOT a claimed completion: it is never reconciled/adopted as success, never auto-retried.
test("shouldReconcileImplement: a reported non-completion off-vocabulary status does NOT reconcile (#865 review)", () => {
  assertEquals(shouldReconcileImplement("failed"), false);
  assertEquals(shouldReconcileImplement("needs_input"), false);
  assertEquals(shouldReconcileImplement("error"), false);
});

test("reconcileImplement: a reported 'failed' status + a branch PR → escalate, NOT adopted as success (#865 review)", async () => {
  let consulted = false;
  const res = await reconcileImplement(
    { status: "failed", subjectKey: "owner/repo#7", taskId: "issue-7" },
    async () => {
      consulted = true;
      return [openPr(9)];
    },
    "token",
  );
  // The open branch PR is never adopted as a success for a reported failure; GitHub is never consulted.
  assertEquals(res, { reconciled: false, status: "failed", pr: null, ...tail });
  assertEquals(consulted, false);
});

// Issue #865 review — a failed/unavailable GitHub lookup does NOT establish that delivery is missing,
// so it must NEVER consume the one automatic retry. Only a SUCCESSFUL lookup confirming no adoptable PR
// may retry a claimed completion.
test("reconcileImplement: claimed-completion + a THROWN lookup → escalate, the retry is NOT consumed (#865 review)", async () => {
  const res = await reconcileImplement(
    { status: "completed", subjectKey: "owner/repo#41", taskId: "issue-41" },
    async () => {
      throw new Error("github 502");
    },
    "token",
  );
  // Escalate, retry untouched — the next pass can still retry/adopt once GitHub recovers. The lookup
  // THREW, so delivery is UNVERIFIED (deliveryVerified: false).
  assertEquals(res, { reconciled: false, status: "completed", pr: null, retry: false, retryNudge: null, retried: false, deliveryVerified: false });
});

test("reconcileImplement: claimed-completion + a NULL listing (no transport) → escalate, the retry is NOT consumed (#865 review)", async () => {
  const res = await reconcileImplement(
    { status: "completed", subjectKey: "owner/repo#41", taskId: "issue-41" },
    async () => null,
    "token",
  );
  assertEquals(res, { reconciled: false, status: "completed", pr: null, retry: false, retryNudge: null, retried: false, deliveryVerified: false });
});

test("reconcileImplement: a blank status + a NULL listing → escalate (unavailable transport, unchanged)", async () => {
  const res = await reconcileImplement(
    { status: null, subjectKey: "owner/repo#7", taskId: "issue-7", pr: "owner/repo#42" },
    async () => null,
    "token",
  );
  assertEquals(res, { reconciled: false, status: null, pr: "owner/repo#42", ...tail });
});
