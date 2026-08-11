// The merge-loop enqueues a "ready" PR (mergeStatus="queued") and parks at `wait-landed`. This
// decision drives what the poller does next from the PR's live GitHub state. The regression it
// guards: a PR that develops a merge CONFLICT after being enqueued (#727/instance 729) must be
// EVICTED back to the mergeable gate, not left waiting forever — while a PR still legitimately in
// the queue (reported BLOCKED/UNSTABLE by GitHub) must keep waiting, never be falsely evicted.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { PrState } from "./github.ts";
import { queuedVerdict } from "./service.ts";

function st(over: Partial<PrState>): PrState {
  return {
    merged: false,
    mergeStateStatus: "CLEAN",
    failingChecks: 0,
    failingCheckNames: [],
    presentCheckNames: [],
    totalChecks: 0,
    isDraft: false,
    headRefOid: null,
    ...over,
  };
}

test("a landed PR advances (merge-landed)", () => {
  assertEquals(queuedVerdict(st({ merged: true, mergeStateStatus: "CLEAN" })), "landed");
  // `merged` wins even if a stale mergeStateStatus lags.
  assertEquals(queuedVerdict(st({ merged: true, mergeStateStatus: "DIRTY" })), "landed");
});

test("a DIRTY (conflicting) PR is evicted — this is the #727 wedge", () => {
  assertEquals(queuedVerdict(st({ merged: false, mergeStateStatus: "DIRTY" })), "evicted");
});

test("a PR still legitimately in the queue keeps waiting (never falsely evicted)", () => {
  // Queuing PRs commonly report these; none is a conflict, so none may evict.
  for (const s of ["CLEAN", "BLOCKED", "UNSTABLE", "BEHIND", "HAS_HOOKS", "UNKNOWN", "DRAFT"]) {
    assertEquals(queuedVerdict(st({ merged: false, mergeStateStatus: s })), "waiting", s);
  }
});
