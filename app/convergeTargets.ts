// The converge-enrollment connector-target vocabulary (ADR 0005, issue #500) — the SINGLE, dependency-
// free source of truth for the `converge` / `converge-merge` literals and their derived semantics.
// Extracted from `deliveryConnector.ts` so the pure, import-free semantic validator (`deliveryGraph.ts`)
// can share the exact same predicate WITHOUT pulling in the connector module's urban/data-layer deps —
// a converge/wait node's late-binding validation (issue #548) must agree with the worker's dispatch
// branch on what "a converge target" is, and this module is what keeps them from drifting.

/** The review-only converge target: enrolls a PR into the shared convergence loop and STOPS at
 * `converged` (never hands it to the merge loop). */
export const CONVERGE_TARGET = "converge";

/** The converge-AND-merge target: enrolls a PR into the shared convergence loop and drives the merge
 * loop too (the canonical `agent → connector[converge-merge] → wait[pr, merged]` land shape). */
export const CONVERGE_MERGE_TARGET = "converge-merge";

/** Is `target` one of the converge-enrollment targets (`converge` / `converge-merge`)? The single
 * predicate the connector worker branches on to route a dispatch into `submitPr`, and the validator
 * branches on to require a bound/literal PR (issue #548). */
export function isConvergeTarget(target: string): boolean {
  return target === CONVERGE_TARGET || target === CONVERGE_MERGE_TARGET;
}

/** The DEFAULT `convergeOnly` for a converge target: `converge` is review-only (`true` — stop at
 * `converged`), `converge-merge` drives the merge loop too (`false`). Maps directly onto `submitPr`'s
 * `convergeOnly` argument. An author may still override it per-dispatch via the connector payload's
 * `convergeOnly`. Only ever consulted behind `isConvergeTarget`, so a non-converge target's `false`
 * is unreachable. */
export function convergeOnlyForTarget(target: string): boolean {
  return target === CONVERGE_TARGET;
}
