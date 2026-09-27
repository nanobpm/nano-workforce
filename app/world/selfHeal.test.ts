// Tests for the no-advance self-heal (issue #818, Layer 2). The orchestration is proven against
// injected primitives (checkpoint reader / PR-head reader / commit comparator / head advancer) so no
// git or network is touched — mirroring the injectable-deps style of the progress-check worker. The
// invariant under test: heal ONLY when a recorded checkpoint STRICTLY fast-forward-descends the PR
// head AND the head was moved; every other outcome degrades safely to `{ healed: false }`.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { attemptNoAdvanceSelfHeal, type SelfHealDeps } from "./selfHeal.ts";

const REPO = "o/r";
const PR_NUM = 7;
const PR_KEY = "o/r#7";
const HEAD = "a".repeat(40);
const AHEAD = "b".repeat(40);

/** Build deps with per-test overrides; every primitive defaults to the happy-path fast-forward. */
function deps(over: Partial<SelfHealDeps> = {}): SelfHealDeps {
  return {
    lastCheckpoint: async () => ({ commitSha: AHEAD }),
    prHead: async () => ({ headRef: "feat/x", headRepo: REPO }),
    compare: async () => ({ status: "ahead", aheadBy: 1, behindBy: 0 }),
    advanceHead: async () => true,
    ...over,
  };
}

test("heals: a checkpoint that strictly fast-forwards the head advances it and continues", async () => {
  const calls: Array<[string, string, string]> = [];
  const res = await attemptNoAdvanceSelfHeal(
    deps({ advanceHead: async (r, b, s) => (calls.push([r, b, s]), true) }),
    REPO,
    PR_NUM,
    PR_KEY,
    HEAD,
  );
  assertEquals(res, { healed: true, sha: AHEAD });
  assertEquals(calls, [[REPO, "feat/x", AHEAD]], "advances the PR head branch to the checkpoint SHA");
});

test("does NOT heal when the PR has no recorded checkpoint (nothing was pushed)", async () => {
  const res = await attemptNoAdvanceSelfHeal(deps({ lastCheckpoint: async () => null }), REPO, PR_NUM, PR_KEY, HEAD);
  assertEquals(res, { healed: false, reason: "no-checkpoint" });
});

test("does NOT heal when the checkpoint already equals the head (nothing stranded)", async () => {
  const res = await attemptNoAdvanceSelfHeal(deps({ lastCheckpoint: async () => ({ commitSha: HEAD }) }), REPO, PR_NUM, PR_KEY, HEAD);
  assertEquals(res, { healed: false, reason: "already-at-head" });
});

test("does NOT heal a diverged checkpoint — a non-fast-forward must escalate, never rewrite history", async () => {
  const res = await attemptNoAdvanceSelfHeal(
    deps({ compare: async () => ({ status: "diverged", aheadBy: 2, behindBy: 3 }) }),
    REPO,
    PR_NUM,
    PR_KEY,
    HEAD,
  );
  assertEquals(res, { healed: false, reason: "not-fast-forward" });
});

test("does NOT heal a behind/identical checkpoint (aheadBy 0 or behindBy > 0)", async () => {
  const behind = await attemptNoAdvanceSelfHeal(
    deps({ compare: async () => ({ status: "behind", aheadBy: 0, behindBy: 4 }) }),
    REPO,
    PR_NUM,
    PR_KEY,
    HEAD,
  );
  assertEquals(behind, { healed: false, reason: "not-fast-forward" });
  const identical = await attemptNoAdvanceSelfHeal(
    deps({ compare: async () => ({ status: "identical", aheadBy: 0, behindBy: 0 }) }),
    REPO,
    PR_NUM,
    PR_KEY,
    HEAD,
  );
  assertEquals(identical, { healed: false, reason: "not-fast-forward" });
});

test("does NOT heal a cross-repo fork head — the base token cannot move a fork's ref", async () => {
  const res = await attemptNoAdvanceSelfHeal(
    deps({ prHead: async () => ({ headRef: "feat/x", headRepo: "someone-else/r" }) }),
    REPO,
    PR_NUM,
    PR_KEY,
    HEAD,
  );
  assertEquals(res, { healed: false, reason: "fork-head" });
});

test("does NOT heal when the PR head ref is unknown", async () => {
  const res = await attemptNoAdvanceSelfHeal(deps({ prHead: async () => ({ headRef: null, headRepo: REPO }) }), REPO, PR_NUM, PR_KEY, HEAD);
  assertEquals(res, { healed: false, reason: "no-head-ref" });
});

test("does NOT heal when the comparison is unavailable (idle transport)", async () => {
  const res = await attemptNoAdvanceSelfHeal(deps({ compare: async () => null }), REPO, PR_NUM, PR_KEY, HEAD);
  assertEquals(res, { healed: false, reason: "compare-unavailable" });
});

test("does NOT heal (and never crashes) when GitHub refuses the fast-forward ref update", async () => {
  const res = await attemptNoAdvanceSelfHeal(deps({ advanceHead: async () => false }), REPO, PR_NUM, PR_KEY, HEAD);
  assertEquals(res, { healed: false, reason: "advance-refused" });
});

test("fails safe (never throws) when a dependency rejects — a transient outage can't fabricate a heal", async () => {
  const res = await attemptNoAdvanceSelfHeal(
    deps({
      compare: async () => {
        throw new Error("boom");
      },
    }),
    REPO,
    PR_NUM,
    PR_KEY,
    HEAD,
  );
  assertEquals(res, { healed: false });
});

test("does not advance the head when the comparison is not a fast-forward", async () => {
  let advanced = false;
  await attemptNoAdvanceSelfHeal(
    deps({
      compare: async () => ({ status: "diverged", aheadBy: 1, behindBy: 1 }),
      advanceHead: async () => ((advanced = true), true),
    }),
    REPO,
    PR_NUM,
    PR_KEY,
    HEAD,
  );
  assertEquals(advanced, false, "the ref is never moved unless the checkpoint strictly fast-forwards the head");
});
