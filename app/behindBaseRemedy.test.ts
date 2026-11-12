// Issue #951 (comment): failing checks on a head BEHIND its base must be remedied mechanically —
// update the branch from base (and close/reopen on a reopen-CI repo) — instead of re-escalating
// "failing required checks" to a human.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { _resetBehindBaseLatch, BEHIND_BASE_PENDING_MS, type BehindBaseDeps, isBehindBaseUpdatePending, maybeUpdateBehindBranch } from "./behindBaseRemedy.ts";
import type { PrState } from "./github.ts";
import { DEFAULT_MERGE_PROTOCOL, type MergeProtocol } from "./mergeProtocol.ts";

function st(over: Partial<PrState> = {}): PrState {
  return {
    merged: false,
    state: "open",
    mergeStateStatus: "BLOCKED",
    failingChecks: 1,
    failingCheckNames: ["build"],
    presentCheckNames: ["build"],
    pendingCheckNames: [],
    checkConclusions: { build: "FAILURE" },
    totalChecks: 1,
    isDraft: false,
    headRefOid: "head1",
    mergeQueueEntry: null,
    unresolvedThreads: 0,
    ...over,
  };
}

const REOPEN: MergeProtocol = { ...DEFAULT_MERGE_PROTOCOL, freshHeadRun: "ready-or-reopen" };

function deps(behindBy: number, calls: string[], updateOk = true, clock = { t: 0 }): BehindBaseDeps {
  return {
    readBase: () => Promise.resolve("main"),
    compare: () => Promise.resolve({ status: behindBy > 0 ? "diverged" : "ahead", aheadBy: 1, behindBy }),
    updateBranch: (_r, _n, _t, sha) => {
      calls.push(`update@${sha}`);
      return Promise.resolve(updateOk);
    },
    now: () => clock.t,
  };
}

test("failing checks on a behind head, reopen-CI repo: update-branch only — never reopen the stale head (#951)", async () => {
  _resetBehindBaseLatch();
  const calls: string[] = [];
  assertEquals(await maybeUpdateBehindBranch("o/r", 1, "t", st(), REOPEN, deps(3, calls)), true);
  assertEquals(calls, ["update@head1"]);
});

test("an accepted (async) update HOLDS the old head until it moves — stale failures never reach fix-ci (#951)", async () => {
  _resetBehindBaseLatch();
  const calls: string[] = [];
  const clock = { t: 0 };
  const d = deps(3, calls, true, clock);
  assertEquals(await maybeUpdateBehindBranch("o/r", 1, "t", st(), REOPEN, d), true);
  clock.t = 60_000; // next poll: GitHub has not applied the update yet
  assertEquals(await maybeUpdateBehindBranch("o/r", 1, "t", st(), REOPEN, d), true);
  assertEquals(calls, ["update@head1"]);
  // The new head appears (up to date) and is still red → falls through to fix-ci.
  assertEquals(await maybeUpdateBehindBranch("o/r", 1, "t", st({ headRefOid: "head2" }), REOPEN, deps(0, calls, true, clock)), false);
});

test("a pending update that never applies stops holding after the bounded window (#951)", async () => {
  _resetBehindBaseLatch();
  const calls: string[] = [];
  const clock = { t: 0 };
  const d = deps(3, calls, true, clock);
  assertEquals(await maybeUpdateBehindBranch("o/r", 1, "t", st(), REOPEN, d), true);
  clock.t = BEHIND_BASE_PENDING_MS;
  assertEquals(await maybeUpdateBehindBranch("o/r", 1, "t", st(), REOPEN, d), false);
});

test("failing checks on a behind head, plain repo: update-branch only (#951)", async () => {
  _resetBehindBaseLatch();
  const calls: string[] = [];
  assertEquals(await maybeUpdateBehindBranch("o/r", 1, "t", st(), DEFAULT_MERGE_PROTOCOL, deps(2, calls)), true);
  assertEquals(calls, ["update@head1"]);
});

test("failing checks on an up-to-date head fall through to fix-ci (#951)", async () => {
  _resetBehindBaseLatch();
  const calls: string[] = [];
  assertEquals(await maybeUpdateBehindBranch("o/r", 1, "t", st(), REOPEN, deps(0, calls)), false);
  assertEquals(calls, []);
});

test("green checks never update the branch (#951)", async () => {
  _resetBehindBaseLatch();
  const calls: string[] = [];
  assertEquals(await maybeUpdateBehindBranch("o/r", 1, "t", st({ failingChecks: 0 }), REOPEN, deps(5, calls)), false);
  assertEquals(calls, []);
});

test("the remedy fires at most once per head (#951)", async () => {
  _resetBehindBaseLatch();
  const calls: string[] = [];
  assertEquals(await maybeUpdateBehindBranch("o/r", 1, "t", st(), REOPEN, deps(3, calls, false)), false);
  assertEquals(await maybeUpdateBehindBranch("o/r", 1, "t", st(), REOPEN, deps(3, calls)), false);
  assertEquals(calls, ["update@head1"]);
});

// The merge-stall probe reads `isBehindBaseUpdatePending` to hold remediation on a stale head. It is
// true only while the SAME head is held inside the bounded window — a moved head or a lapsed window
// reads false, and it never mutates the pending state (the remedy still owns the lifecycle).
test("isBehindBaseUpdatePending holds the old head only within the bounded window (#951)", async () => {
  _resetBehindBaseLatch();
  const clock = { t: 0 };
  assertEquals(await maybeUpdateBehindBranch("o/r", 1, "t", st(), REOPEN, deps(3, [], true, clock)), true);
  // Same head, inside the window → pending. A different head, or a lapsed window → not pending.
  assertEquals(isBehindBaseUpdatePending("o/r", 1, "head1", () => clock.t), true);
  assertEquals(isBehindBaseUpdatePending("o/r", 1, "head2", () => clock.t), false);
  assertEquals(isBehindBaseUpdatePending("o/r", 1, "head1", () => clock.t + BEHIND_BASE_PENDING_MS), false);
  // A PR with no accepted update is never pending.
  assertEquals(isBehindBaseUpdatePending("o/r", 999, "head1", () => clock.t), false);
});
