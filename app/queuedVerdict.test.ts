// The merge-loop enqueues a "ready" PR (mergeStatus="queued") and parks at `wait-landed`. This
// decision drives what the poller does next from the PR's live GitHub state. The regression it
// guards: a PR that develops a merge CONFLICT after being enqueued (#727/instance 729) must be
// EVICTED back to the mergeable gate, not left waiting forever — while a PR still legitimately in
// the queue (reported BLOCKED/UNSTABLE by GitHub) must keep waiting, never be falsely evicted. It
// also guards #702: a PR EVICTED because required checks failed on the speculative `merge_group`
// commit is NOT `DIRTY`, so a ground-truth `mergeQueueEntry === false` must classify it `evicted`
// (the old `DIRTY`-only classifier left it waiting out the full `landedWaitTimeout`, then escalated
// to a human, instead of auto-re-driving `fix-ci`).
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { PrState } from "./github.ts";
import { queuedVerdict } from "./service.ts";

function st(over: Partial<PrState>): PrState {
  return {
    merged: false,
    state: "open",
    mergeStateStatus: "CLEAN",
    failingChecks: 0,
    failingCheckNames: [],
    presentCheckNames: [],
    totalChecks: 0,
    isDraft: false,
    headRefOid: null,
    mergeQueueEntry: null,
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
  // Queuing PRs commonly report these; none is a conflict, and with an unprobed/indeterminate
  // membership (`mergeQueueEntry: null`) none may evict.
  for (const s of ["CLEAN", "BLOCKED", "UNSTABLE", "BEHIND", "HAS_HOOKS", "UNKNOWN", "DRAFT"]) {
    assertEquals(queuedVerdict(st({ merged: false, mergeStateStatus: s })), "waiting", s);
  }
});

// ── #702: a merge-queue eviction caused by a red `merge_group` build leaves the head NOT `DIRTY`
// (it reverts to BLOCKED/UNSTABLE/CLEAN). Inferring from `mergeStateStatus` alone kept such a PR
// "waiting" until the PT1H `landedWaitTimeout` escalated to a human, instead of auto-re-driving
// `fix-ci`. Ground-truth `mergeQueueEntry === false` now classifies it `evicted`.

test("#702: a queued PR dropped from the queue (mergeQueueEntry=false) evicts even when not DIRTY", () => {
  // The exact CI-on-merge_group eviction shapes: no conflict, but no longer enrolled.
  for (const s of ["BLOCKED", "UNSTABLE", "CLEAN", "BEHIND", "HAS_HOOKS", "UNKNOWN"]) {
    assertEquals(queuedVerdict(st({ merged: false, mergeStateStatus: s, mergeQueueEntry: false })), "evicted", s);
  }
});

test("#702 regression: a PR still ENROLLED (mergeQueueEntry=true) but BLOCKED keeps waiting", () => {
  // A pending queue check reports BLOCKED/UNSTABLE while genuinely still in the queue — must NOT
  // evict, or every legitimately-queuing PR would thrash `arm-merge`.
  for (const s of ["BLOCKED", "UNSTABLE", "CLEAN"]) {
    assertEquals(queuedVerdict(st({ merged: false, mergeStateStatus: s, mergeQueueEntry: true })), "waiting", s);
  }
});

test("#702: indeterminate membership (mergeQueueEntry=null, e.g. Mergify/token GraphQL error) keeps waiting", () => {
  // A repo with no native merge queue (or an unreadable probe) leaves the #556 `landedWaitTimeout`
  // backstop to handle a never-lands wedge — we must not falsely evict on a perpetually-null entry.
  for (const s of ["BLOCKED", "UNSTABLE", "CLEAN"]) {
    assertEquals(queuedVerdict(st({ merged: false, mergeStateStatus: s, mergeQueueEntry: null })), "waiting", s);
  }
  // …but a real conflict still evicts regardless of an unprobed membership (token-mode path).
  assertEquals(queuedVerdict(st({ merged: false, mergeStateStatus: "DIRTY", mergeQueueEntry: null })), "evicted");
});
