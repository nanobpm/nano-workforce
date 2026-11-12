// Issue #951 (comment): failing checks on a head BEHIND its base must be remedied mechanically —
// update the branch from base (and close/reopen on a reopen-CI repo) — instead of re-escalating
// "failing required checks" to a human.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { _resetBehindBaseLatch, type BehindBaseDeps, maybeUpdateBehindBranch } from "./behindBaseRemedy.ts";
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

function deps(behindBy: number, calls: string[], updateOk = true): BehindBaseDeps {
  return {
    readBase: () => Promise.resolve("main"),
    compare: () => Promise.resolve({ status: behindBy > 0 ? "diverged" : "ahead", aheadBy: 1, behindBy }),
    updateBranch: (_r, _n, _t, sha) => {
      calls.push(`update@${sha}`);
      return Promise.resolve(updateOk);
    },
    freshHeadRun: (_r, _n, action) => {
      calls.push(action);
      return Promise.resolve(true);
    },
  };
}

test("failing checks on a behind head: update-branch then reopen (reopen-CI repo) (#951)", async () => {
  _resetBehindBaseLatch();
  const calls: string[] = [];
  assertEquals(await maybeUpdateBehindBranch("o/r", 1, "t", st(), REOPEN, deps(3, calls)), true);
  assertEquals(calls, ["update@head1", "reopen"]);
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
