// Unit coverage for the pure node completion-policy vocabulary `app/nodePolicy.ts` (ADR 0006 §3,
// slice S5). Exercises the two ideas S5 promotes to first-class, enforced policy — with no engine and
// no side effects:
//   • the RAW converge/merge retirement predicate (`isRawConvergeMergeJobType`) that makes "a raw
//     converge node not expressible" (issue #592 acceptance #1) while leaving every legitimate verb —
//     crucially `senior:trial-merge`, the merge-cell's own internal body — untouched, and
//   • the TWO-LEVEL merge mapping (`mergeLevelForTarget` / `mergeBranchForLevel`): a unit lands onto
//     its base branch, the graph lands onto `main`, and a unit can NEVER silently collapse onto `main`
//     (issue #592 acceptance #2, ADR 0003 base-branch admission).
import { test } from "node:test";
import { assert, assertEquals, assertThrows } from "#test-assert";
import { CONVERGE_MERGE_TARGET, CONVERGE_TARGET, MERGE_MAIN_TARGET } from "./convergeTargets.ts";
import {
  GRAPH_MERGE_BRANCH,
  isRawConvergeMergeJobType,
  jobTypeVerb,
  MERGE_LEVEL_TARGET,
  mergeBranchForLevel,
  mergeLevelForTarget,
  NODE_COMPLETION_POLICIES,
  RAW_CONVERGE_MERGE_VERBS,
} from "./nodePolicy.ts";

test("RAW_CONVERGE_MERGE_VERBS is derived from NODE_COMPLETION_POLICIES (single source of truth, no drift)", () => {
  assertEquals([...RAW_CONVERGE_MERGE_VERBS], [...NODE_COMPLETION_POLICIES]);
});

test("jobTypeVerb extracts the task verb after the last colon, trimmed + lower-cased", () => {
  assertEquals(jobTypeVerb("senior:feature"), "feature");
  assertEquals(jobTypeVerb("senior:trial-merge"), "trial-merge");
  assertEquals(jobTypeVerb("converge"), "converge");
  assertEquals(jobTypeVerb("staff:Merge"), "merge");
  assertEquals(jobTypeVerb("a:b:merge "), "merge");
});

test("isRawConvergeMergeJobType retires raw converge/merge agent jobs (any rank, bare, mixed case)", () => {
  assert(isRawConvergeMergeJobType("senior:converge"));
  assert(isRawConvergeMergeJobType("senior:merge"));
  assert(isRawConvergeMergeJobType("converge"));
  assert(isRawConvergeMergeJobType("merge"));
  assert(isRawConvergeMergeJobType("staff:Merge"));
});

test("isRawConvergeMergeJobType leaves legitimate verbs untouched (exact-verb match, not substring)", () => {
  // `senior:trial-merge` is the merge-cell's own internal trial body — it must NOT be swept up.
  assert(!isRawConvergeMergeJobType("senior:trial-merge"));
  assert(!isRawConvergeMergeJobType("senior:feature"));
  assert(!isRawConvergeMergeJobType("senior:fix"));
  assert(!isRawConvergeMergeJobType("j"));
  assert(!isRawConvergeMergeJobType("merge-cell"));
});

test("MERGE_LEVEL_TARGET pairs each level with its converge-enrollment target", () => {
  assertEquals(MERGE_LEVEL_TARGET.unit, CONVERGE_MERGE_TARGET);
  assertEquals(MERGE_LEVEL_TARGET.graph, MERGE_MAIN_TARGET);
});

test("mergeLevelForTarget maps the two-level merge targets, null for non-landing/other targets", () => {
  assertEquals(mergeLevelForTarget(CONVERGE_MERGE_TARGET), "unit");
  assertEquals(mergeLevelForTarget(MERGE_MAIN_TARGET), "graph");
  // `converge` is review-only (non-landing) → not a merge level.
  assertEquals(mergeLevelForTarget(CONVERGE_TARGET), null);
  assertEquals(mergeLevelForTarget("slack:#x"), null);
});

test("mergeBranchForLevel: two-level merge — unit lands on its base branch, graph lands on main", () => {
  assertEquals(mergeBranchForLevel("unit", { baseBranch: "epic/some-epic" }), "epic/some-epic");
  assertEquals(mergeBranchForLevel("graph", { baseBranch: "epic/some-epic" }), GRAPH_MERGE_BRANCH);
  assertEquals(GRAPH_MERGE_BRANCH, "main");
  // The graph level ignores any supplied base — it ALWAYS targets main.
  assertEquals(mergeBranchForLevel("graph", { baseBranch: null }), "main");
});

test("mergeBranchForLevel: a unit can NEVER silently collapse onto main — missing base throws", () => {
  assertThrows(() => mergeBranchForLevel("unit", { baseBranch: null }));
  assertThrows(() => mergeBranchForLevel("unit", { baseBranch: "   " }));
  assertThrows(() => mergeBranchForLevel("unit", {}));
});
