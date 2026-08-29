// nano-workforce — the first-class NODE COMPLETION-POLICY vocabulary for an agent-authored delivery
// graph (ADR 0006 §3, slice S5). The pure, dependency-free source of truth for two ideas the ADR
// promotes from EMERGENT behaviour / smuggled prompt prose to explicit, EDGE-GATED, compiler-enforced
// policy:
//
//   1. `converge?` / `merge?` are first-class completion-policy FLAGS on a cell (`agent`) node, NOT
//      raw nodes. "get to green, then land" used to live in a gateway inside `feature.bpmn`
//      (`gw-converge` + the `autoMerge` boolean) and, for a delivery-graph `agent` node, in FREE TEXT
//      in a prompt ("un-draft + merge #B"). This module gives the validator/compiler the predicate
//      that RETIRES a raw converge/merge agent job (`senior:converge`, `senior:merge`) — converge and
//      merge survive only as the `converge`/`merge` policy on a cell, so "a raw converge node is not
//      expressible in the authored vocabulary" (issue #592 acceptance #1).
//
//   2. `merge` is TWO-LEVEL (ADR 0003 base-branch admission, ADR 0006 §3): a UNIT's merge lands onto
//      its epic/graph BASE branch, never `main` directly; the GRAPH's final merge-to-`main` is a
//      separate top-level step. This module maps each level to its converge-enrollment target
//      (`converge-merge` = unit → base, `merge-main` = graph → main) and resolves the branch a level
//      lands on, so the two levels are authored/enforced explicitly rather than collapsed.
//
// Kept import-light (only the dependency-free `convergeTargets.ts` literals) so the pure semantic
// validator (`deliveryGraph.ts`) can share these predicates WITHOUT pulling in the connector module's
// urban/data-layer deps.

import { CONVERGE_MERGE_TARGET, MERGE_MAIN_TARGET } from "./convergeTargets.ts";

/** The first-class node completion-policy flags a cell (`agent`) node may carry (ADR 0006 §3). Both
 * are separable phases: `converge` drives the PR through its review-convergence loop to green;
 * `merge` lands it. Kept as the single source of truth so the validator, the openapi shape, and any
 * future compiler agree on the closed policy set. */
export const NODE_COMPLETION_POLICIES = ["converge", "merge"] as const;

/** A node completion policy, narrowed to the closed set. */
export type NodeCompletionPolicy = (typeof NODE_COMPLETION_POLICIES)[number];

/** The reserved task VERBS that name a converge/merge phase. An `agent` node's `jobType` is
 * `<rank>:<task>` (e.g. `senior:feature`), or a bare `<task>`; its task verb is the segment after the
 * last `:`. A jobType whose verb is exactly `converge` or `merge` is a RAW converge/merge node — the
 * exact thing S5 retires: converge/merge are cell POLICY (`converge?`/`merge?`), never a raw agent
 * job. Matched by exact verb equality (case-insensitive) so a legitimately-different verb that merely
 * CONTAINS the word — e.g. `senior:trial-merge` (verb `trial-merge`), the real merge-cell body — is
 * NOT swept up. Derived from {@link NODE_COMPLETION_POLICIES} so the reserved-verb vocabulary and the
 * cell policy set cannot drift (they are the same closed set, seen from two angles). */
export const RAW_CONVERGE_MERGE_VERBS: readonly string[] = NODE_COMPLETION_POLICIES;

/** Extract the task verb from an agent `jobType`: the segment after the LAST `:` (`senior:feature` →
 * `feature`), or the whole string when unqualified. Trimmed and lower-cased for a stable compare. */
export function jobTypeVerb(jobType: string): string {
  const colon = jobType.lastIndexOf(":");
  const verb = colon >= 0 ? jobType.slice(colon + 1) : jobType;
  return verb.trim().toLowerCase();
}

/** True when `jobType` names a RAW converge/merge node — an agent job whose task verb is exactly
 * `converge` or `merge`. These are retired as user-facing vocabulary (issue #592): the author must
 * express convergence/landing via the cell's first-class `converge?` / `merge?` policy, not a raw
 * agent job. `senior:trial-merge` (the merge-cell's internal trial body) and every non-converge verb
 * are unaffected. */
export function isRawConvergeMergeJobType(jobType: string): boolean {
  const verb = jobTypeVerb(jobType);
  for (const raw of RAW_CONVERGE_MERGE_VERBS) if (raw === verb) return true;
  return false;
}

/** The two levels a `merge` lands at (ADR 0006 §3 two-level merge). `unit` = a delivery UNIT (a
 * feature/slice PR) landing onto its epic/graph base branch; `graph` = the top-of-graph integration
 * landing onto `main`. */
export const MERGE_LEVELS = ["unit", "graph"] as const;

/** A merge level, narrowed to the closed set. */
export type MergeLevel = (typeof MERGE_LEVELS)[number];

/** The converge-enrollment connector target each merge level dispatches through: a UNIT merge lands
 * via `converge-merge` (onto its own base branch), the GRAPH's top-level merge via `merge-main` (onto
 * `main`). The single source of truth pairing the two-level policy with the connector vocabulary. */
export const MERGE_LEVEL_TARGET: Record<MergeLevel, string> = {
  unit: CONVERGE_MERGE_TARGET,
  graph: MERGE_MAIN_TARGET,
};

/** Reverse of {@link MERGE_LEVEL_TARGET}: the merge level a converge-enrollment `target` names, or
 * `null` when the target is not a two-level merge target (`converge` is review-only, non-landing).
 * Lets the validator/compiler decide which branch a merge cell lands on from the authored target. */
export function mergeLevelForTarget(target: string): MergeLevel | null {
  if (target === CONVERGE_MERGE_TARGET) return "unit";
  if (target === MERGE_MAIN_TARGET) return "graph";
  return null;
}

/** Resolve the branch a merge LEVEL lands on (ADR 0003 base-branch admission). A `unit` merge lands on
 * the supplied `baseBranch` (the epic/graph integration branch the unit PR targets); a `graph` merge
 * lands on `main`. The two-level invariant in one place: a unit NEVER lands on `main` directly, and
 * the graph's top-level merge ALWAYS targets `main`. `baseBranch` is required for a unit level (its
 * whole point is "not main"); an absent/empty base for a unit is a caller error surfaced as a throw so
 * a unit can never silently collapse onto `main`. */
export const GRAPH_MERGE_BRANCH = "main";

export function mergeBranchForLevel(level: MergeLevel, opts: { baseBranch?: string | null }): string {
  if (level === "graph") return GRAPH_MERGE_BRANCH;
  const base = opts.baseBranch?.trim();
  if (!base) {
    throw new Error(
      "unit-level merge requires a base branch (ADR 0003 two-level merge: a unit lands onto its " +
        "epic/graph base branch, never `main` directly)",
    );
  }
  return base;
}
