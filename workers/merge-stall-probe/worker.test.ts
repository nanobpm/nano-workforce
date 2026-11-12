// pr.merge-stall-probe — issue #951: the probe must re-read PR state before the merge loop can
// escalate. A PR that already MERGED (a human queued it while the loop waited) must surface `ready`
// so `gw-merge-stall` routes it to `attempt-merge` (whose already-merged short-circuit ends the loop
// as merged) instead of exhausting the stall budget into a "merge-blocked" escalation.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { PrState } from "../../app/github.ts";
import { DEFAULT_MERGE_PROTOCOL, type MergeProtocol } from "../../app/mergeProtocol.ts";
import { noopLog } from "../../test/log.ts";
import { makeHandler } from "./worker.ts";

function state(over: Partial<PrState>): PrState {
  return {
    merged: false,
    state: "open",
    mergeStateStatus: "BLOCKED",
    failingChecks: 0,
    failingCheckNames: [],
    presentCheckNames: ["build", "Mergify Merge Queue"],
    pendingCheckNames: [],
    checkConclusions: { build: "SUCCESS", "Mergify Merge Queue": "NEUTRAL" },
    totalChecks: 2,
    isDraft: false,
    headRefOid: "abc",
    mergeQueueEntry: null,
    unresolvedThreads: 0,
    ...over,
  };
}

const MERGIFY: MergeProtocol = {
  ...DEFAULT_MERGE_PROTOCOL,
  land: { method: "mergify-queue", comment: "@mergifyio queue" },
  requiredChecks: [{ name: "build", acceptedConclusions: ["success"] }],
};

async function run(st: PrState, protocol: MergeProtocol | null, isUpdatePending = false): Promise<Record<string, unknown>> {
  const handler = makeHandler({
    readState: () => Promise.resolve(st),
    readProtocol: () => Promise.resolve(protocol),
    isUpdatePending: () => isUpdatePending,
  });
  const job: any = { variables: { prKey: "o/r#1", repo: "o/r", prNumber: 1 } };
  const app: any = { log: noopLog() };
  return (await handler(job, app)) as Record<string, unknown>;
}

test("merge-stall-probe: a PR already MERGED surfaces `ready` (never an escalation) (#951)", async () => {
  const out = await run(state({ merged: true, state: "merged", mergeStateStatus: "UNKNOWN" }), MERGIFY);
  assertEquals(out.mergeState, "ready");
});

test("merge-stall-probe: a CLOSED PR surfaces `ready` so attempt-merge abandons it (#951)", async () => {
  const out = await run(state({ state: "closed", mergeStateStatus: "UNKNOWN" }), null);
  assertEquals(out.mergeState, "ready");
});

test("merge-stall-probe: green PR awaiting `@mergifyio queue` is `ready`, not a review stall (#951)", async () => {
  const out = await run(state({}), MERGIFY);
  assertEquals(out.mergeState, "ready");
});

test("merge-stall-probe: BLOCKED gh-merge PR with green checks still waits (#951)", async () => {
  const out = await run(state({}), { ...MERGIFY, land: { method: "gh-merge" } });
  assertEquals(out.mergeState, "waiting");
});

// Issue #951 review: while an accepted (async) update-branch still exposes the old head, the probe
// must NOT classify that head's stale check failures as `blocked` (which starts fix-ci / escalates).
// It defers to `waiting` (bounded re-poll) until the head moves or the remedy's window lapses.
test("merge-stall-probe: a blocked verdict on a pending-update old head defers to waiting (#951)", async () => {
  const blocked = state({ failingChecks: 1, failingCheckNames: ["build"], checkConclusions: { build: "FAILURE" } });
  // Sanity: without a pending update this IS blocked (would route to fix-ci).
  assertEquals((await run(blocked, MERGIFY, false)).mergeState, "blocked");
  // With the update still pending on this head, the probe holds remediation.
  const held = await run(blocked, MERGIFY, true);
  assertEquals(held.mergeState, "waiting");
  // The hold is surfaced so gw-merge-stall re-polls past the stall cap (only for this hold).
  assertEquals(held.updatePending, true);
  assertEquals((await run(blocked, MERGIFY, false)).updatePending, false);
});

test("merge-stall-probe: a non-blocked verdict is never downgraded by a pending update (#951)", async () => {
  // A ready PR stays ready even if (spuriously) an update is pending — the hold only masks `blocked`.
  const out = await run(state({}), MERGIFY, true);
  assertEquals(out.mergeState, "ready");
});
