// Regression guard for the frugal-CI self-heal escalation fall-through (PR #455 review).
//
// `maybeEnsureFreshHeadRun` gates the `"draft"` merge branch: the poller `continue`s (re-polls)
// when it returns `true`, and falls through to the actionable "mark it ready" escalation when it
// returns `false`. The bug: it returned `true` whenever an action was *selected*, even if
// `ensureFreshHeadRun` FAILED (`ok === false`, e.g. missing permission / repo policy). A draft PR
// whose self-heal can never succeed would then `continue` forever, re-attempting `gh pr ready`/
// reopen every pass and never escalating to a human. The fix returns `ok`, so a persistently
// failing self-heal falls through to escalation. These tests pin: return value tracks `ok`;
// persistence (`fresh_head_run_head`) happens only on success; and no action → no attempt.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import type { PrState } from "./github.ts";
import { parseMergeProtocol } from "./mergeProtocol.ts";
import { maybeEnsureFreshHeadRun, type PullRequest } from "./service.ts";

const READY = parseMergeProtocol({ freshHeadRun: "ready", land: { method: "gh-merge" } });

function memData(seed: PullRequest): { data: DataLayer; row: () => PullRequest } {
  const rows: PullRequest[] = [{ ...seed }];
  const table = {
    async update(id: string, patch: Partial<PullRequest>) {
      const r = rows.find((x) => x.pr_key === id);
      if (r) Object.assign(r, patch);
    },
  };
  const data = { table: () => table } as unknown as DataLayer;
  return { data, row: () => rows[0] };
}

function draftState(overrides: Partial<PrState> = {}): PrState {
  return {
    merged: false,
    state: "open",
    mergeStateStatus: "DRAFT",
    failingChecks: 0,
    failingCheckNames: [],
    totalChecks: 0, // no head run yet → frugal-CI stuck state
    presentCheckNames: [],
    pendingCheckNames: [],
    checkGateConclusions: {},
    isDraft: true,
    headRefOid: "h1",
    ...overrides,
  };
}

function prRow(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    pr_key: "o/r#1",
    repo: "o/r",
    number: 1,
    url: "https://github.com/o/r/pull/1",
    title: "t",
    status: "waiting_merge",
    current_round: 0,
    process_key: null,
    waiting_since: null,
    last_review_id: null,
    outcome: null,
    created_at: "t",
    updated_at: "t",
    converged_at: null,
    merged_at: null,
    active_worker: null,
    lease_until: null,
    last_nudge_at: null,
    fresh_head_run_head: null,
    abandon_token: null,
    incident_key: null,
    incident_message: null,
    root_request_key: null,
    ...overrides,
  };
}

test("maybeEnsureFreshHeadRun: successful self-heal returns true and records the head", async () => {
  const { data, row } = memData(prRow());
  const ret = await maybeEnsureFreshHeadRun(
    data,
    "o/r",
    1,
    "o/r#1",
    READY,
    "draft",
    draftState(),
    prRow(),
    async () => true,
  );
  assertEquals(ret, true); // caller re-polls
  assertEquals(row().fresh_head_run_head, "h1"); // one-shot de-dupe recorded
});

test("maybeEnsureFreshHeadRun: FAILED self-heal returns false so the draft branch escalates", async () => {
  const { data, row } = memData(prRow());
  const ret = await maybeEnsureFreshHeadRun(
    data,
    "o/r",
    1,
    "o/r#1",
    READY,
    "draft",
    draftState(),
    prRow(),
    async () => false, // ensureFreshHeadRun could not perform the action (e.g. permission)
  );
  assertEquals(ret, false); // caller falls through to the actionable escalation
  assertEquals(row().fresh_head_run_head, null); // not recorded → not a wasted one-shot
});

test("maybeEnsureFreshHeadRun: a throwing self-heal is caught and returns false", async () => {
  const { data, row } = memData(prRow());
  const ret = await maybeEnsureFreshHeadRun(
    data,
    "o/r",
    1,
    "o/r#1",
    READY,
    "draft",
    draftState(),
    prRow(),
    async () => {
      throw new Error("boom");
    },
  );
  assertEquals(ret, false);
  assertEquals(row().fresh_head_run_head, null);
});

test("maybeEnsureFreshHeadRun: no applicable action never attempts the self-heal and returns false", async () => {
  const { data } = memData(prRow());
  let attempted = false;
  const ret = await maybeEnsureFreshHeadRun(
    data,
    "o/r",
    1,
    "o/r#1",
    READY,
    "draft",
    draftState({ totalChecks: 1 }), // required run already present → no action selected
    prRow(),
    async () => {
      attempted = true;
      return true;
    },
  );
  assertEquals(ret, false);
  assert(!attempted, "must not attempt a self-heal when no action applies");
});

// PR #968 review (finding 2): the draft-promotion path must NOT record `fresh_head_run_head`, or it
// would suppress the close/reopen a `freshHeadRun: "reopen"` repo needs to START CI on
// `opened`/`reopened`-only workflows. After promotion the PR is no longer a draft, so the next poll
// re-classifies it `waiting` and lands HERE. This pins that subsequent pass: a non-draft with no
// head run and a NULL `fresh_head_run_head` (promotion left it untouched) MUST still fire the reopen.
test("maybeEnsureFreshHeadRun: a promoted draft (non-draft, no run, marker untouched) still fires the reopen", async () => {
  const REOPEN = parseMergeProtocol({ freshHeadRun: "reopen", land: { method: "gh-merge" } });
  const { data, row } = memData(prRow()); // fresh_head_run_head: null — promotion did NOT record it
  let action: string | null = null;
  const ret = await maybeEnsureFreshHeadRun(
    data,
    "o/r",
    1,
    "o/r#1",
    REOPEN,
    "waiting", // the post-promotion verdict (isDraft flipped false → no longer "draft")
    draftState({ isDraft: false, totalChecks: 0 }), // promoted, but no head run yet
    prRow(),
    async (_repo, _n, act) => {
      action = act;
      return true;
    },
  );
  assertEquals(ret, true); // the close/reopen CI-start fired (not suppressed)
  assertEquals(action, "reopen");
  assertEquals(row().fresh_head_run_head, "h1"); // the self-heal's own one-shot de-dupe, recorded now
});
