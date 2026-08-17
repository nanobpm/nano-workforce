// Canonical PR-terminal / epic-delivery derivation, extracted from `service.ts` so that the
// lineage read-projection (`app/lineage.ts`) can reuse `deriveDelivery`/`TERMINAL_STATUSES`
// without importing `service.ts` — which imports `pollLineage` back from `lineage.ts` and would
// otherwise form a `service.ts` ↔ `lineage.ts` module cycle (fragile in ESM). This is the single
// source of truth for both; `service.ts` re-uses it and remains free to import `pollLineage`.

/** A PR is "done" in exactly these states; everything else (converging, waiting_review,
 * escalated, and the merge-stage waiting_deps/waiting_merge/waiting_lane/queued) is in flight. `converged`
 * is terminal only in review-only mode (AUTO_MERGE off); with auto-merge on, a converged PR
 * transitions into the merge stage and lands as `merged`. The status endpoint and the cancel
 * guard both key off this set. */
export const TERMINAL_STATUSES: readonly string[] = ["converged", "merged", "abandoned"];

/** The derived epic delivery signal (issue #171). Distinct from `plan.status`: `status = done`
 * means "the fan-out finished and ≥1 slice opened a PR, dispatched to convergence" (record-results
 * sets it as soon as one PR opened — other slices may be blocked/skipped), which conflates hand-off
 * with landing. `delivery` reports whether those slice PRs have actually MERGED. */
export type Delivery = "converging" | "landed";

/** Rollup of a plan's slice-PR landing state, derived by joining `plan_tasks.pr_key` →
 * `pull_requests.status`. Pure and read-only — the single source of truth for the denormalised
 * `plans.delivery` / `plans.delivery_label` columns the poller projects. */
export interface DeliveryRollup {
  delivery: Delivery | null;
  label: string | null;
  prsOpened: number;
  prsMerged: number;
  prsInFlight: number;
}

/** Derive the delivery signal for one plan from its status and the statuses of its slice PRs.
 *
 * - `converging` — the plan is `done` but ≥1 slice PR is still non-terminal (in flight).
 * - `landed` — every slice PR merged: `prsInFlight == 0 && prsMerged == prsOpened && prsOpened > 0`.
 * - `null` — no positive signal yet: the plan isn't `done`, it opened no PRs, or every PR is
 *   terminal but not all merged (some `abandoned`/`converged` — resolved-not-landed, per the issue).
 *
 * A slice's PR status is "in flight" iff it is NOT in `TERMINAL_STATUSES`; `abandoned`/`converged`
 * count as resolved-not-landed (terminal but not merged), so they never make an epic `landed`. */
export function deriveDelivery(
  planStatus: string,
  prStatuses: readonly string[],
): DeliveryRollup {
  const prsOpened = prStatuses.length;
  let prsMerged = 0;
  let prsInFlight = 0;
  for (const s of prStatuses) {
    if (s === "merged") prsMerged++;
    else if (!TERMINAL_STATUSES.includes(s)) prsInFlight++;
  }
  // `delivery` is only meaningful once the fan-out has been dispatched (`status = done`) and at
  // least one slice PR exists; otherwise there is nothing to have landed yet.
  if (planStatus !== "done" || prsOpened === 0) {
    return { delivery: null, label: null, prsOpened, prsMerged, prsInFlight };
  }
  if (prsInFlight > 0) {
    return {
      delivery: "converging",
      label: `${prsMerged}/${prsOpened} slices merged, ${prsInFlight} converging`,
      prsOpened,
      prsMerged,
      prsInFlight,
    };
  }
  if (prsMerged === prsOpened) {
    return {
      delivery: "landed",
      label: `${prsOpened}/${prsOpened} slices merged`,
      prsOpened,
      prsMerged,
      prsInFlight,
    };
  }
  // Every slice PR is terminal but not all merged (some abandoned/converged): resolved, not landed.
  return { delivery: null, label: null, prsOpened, prsMerged, prsInFlight };
}
