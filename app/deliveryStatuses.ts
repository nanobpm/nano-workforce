// The PR statuses that are TERMINAL for epic delivery — a slice PR in any of these is resolved (not
// in flight). This is the ONE canonical set, factored into a dependency-neutral leaf module (imports
// nothing) so BOTH sides of the single-sourced delivery derivation read the SAME value and can never
// drift: the runtime adapters + consumers via `app/delivery.ts` (which re-exports it as
// `TERMINAL_STATUSES`), and the `plan_delivery_counts` / `plan_wave_counts` rollups' in-flight fold via
// `app/planRollups.ts`. Adding or removing a terminal state here changes both the SQL VIEW counts and
// the TS reduce at once.
//
// `converged` is terminal only in review-only mode (AUTO_MERGE off); with auto-merge on, a converged PR
// transitions into the merge stage and lands as `merged`. `merged` is the landed state; `abandoned` is
// the resolved-not-landed state. Everything else (converging, waiting_review, escalated, and the
// merge-stage waiting_deps/waiting_merge/waiting_lane/queued) is in flight.
export const TERMINAL_STATUSES: readonly string[] = ["converged", "merged", "abandoned"];

// The merge-stage PR statuses: a PR is here only AFTER review convergence (pr.finalize hands a
// converged PR to merge-loop, which parks it in waiting_deps → waiting_merge/waiting_lane → queued /
// merging). A handback into review leaves this set (back to a review status), so membership here
// implies "converged, not yet landed". Consumed by the run-wait `converged` predicate (app/runWait.ts).
export const MERGE_STAGE_STATUSES: readonly string[] = ["waiting_deps", "waiting_merge", "waiting_lane", "queued", "merging"];
