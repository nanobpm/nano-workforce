import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { PrState } from "../../app/github.ts";
import { probeLanded } from "./worker.ts";

const base: PrState = {
  merged: false,
  state: "open",
  mergeStateStatus: "BLOCKED",
  failingChecks: 0,
  failingCheckNames: [],
  totalChecks: 0,
  presentCheckNames: [],
  pendingCheckNames: [],
  checkGateConclusions: {},
  isDraft: false,
  headRefOid: null,
  mergeQueueEntry: null,
  unresolvedThreads: -1,
};
const fake = (st: PrState | null, fail = false) => async () => {
  if (fail) throw new Error("boom");
  return st;
};

test("landed-probe: a MERGED PR reads landed (#933)", async () => {
  assertEquals(await probeLanded("a/b", 1, "", fake({ ...base, merged: true, state: "merged" })), "landed");
});
test("landed-probe: still queued reads waiting", async () => {
  assertEquals(await probeLanded("a/b", 1, "", fake(base)), "waiting");
});
test("landed-probe: dropped from the native queue reads evicted", async () => {
  assertEquals(await probeLanded("a/b", 1, "", fake({ ...base, mergeQueueEntry: false })), "evicted");
});
test("landed-probe: closed unmerged reads evicted", async () => {
  assertEquals(await probeLanded("a/b", 1, "", fake({ ...base, state: "closed" })), "evicted");
});
test("landed-probe: unreadable state is conservative (waiting)", async () => {
  assertEquals(await probeLanded("a/b", 1, "", fake(null)), "waiting");
  assertEquals(await probeLanded("a/b", 1, "", fake(null, true)), "waiting");
});
