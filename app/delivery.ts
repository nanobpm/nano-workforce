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

/** The `plan.status` values that mean the epic's fan-out lifecycle is still LIVE — the planner is
 * decomposing (`planning`) or the fleet is implementing (`dispatched`). Both are unambiguously
 * in-flight, so an epic in either status is always in the Active bucket regardless of `delivery`. */
export const EPIC_LIVE_STATUSES: readonly string[] = ["planning", "dispatched"];

/** The Active/History partition for an EPIC (issue #298), the twin of feature runs'
 * `deriveListBucket` (app/stage.ts). It exists because an epic must NOT vanish from the Active list
 * the instant `plan.status` becomes `done`: `done` only means "the fan-out finished and ≥1 slice
 * opened a PR, dispatched to convergence" (see the `Delivery` doc above — it "conflates hand-off with
 * landing"), so a `done` epic whose slice PRs are still CONVERGING, or one that has fully LANDED but
 * still needs its integration→main promotion PR raised, still needs the operator's attention.
 *
 * Bucket on the derived `delivery` rollup (the single source of truth this consumes), NOT raw
 * `status`. An epic is *in-flight* (`active`) while:
 *   • `status` is live (`planning`/`dispatched`), OR
 *   • it is `done` and NOT yet acknowledged — a done epic stays visible/actionable (surfacing
 *     `delivery_label`, e.g. "5/5 slices merged, promote to main") until the operator dismisses it,
 *     mirroring feature runs' terminal tick-off. This deliberately covers `delivery = null` too:
 *     record-results only reaches `done` with ≥1 opened PR (a zero-PR plan is `failed`, #86), so a
 *     just-`done` epic whose `delivery` the poller has not yet projected must NOT flicker into
 *     History — the very vanish this issue fixes. A `converging` epic is likewise Active, and its
 *     Dismiss affordance stays closed (see {@link epicIsAcknowledgeable}) so it is never ticked off
 *     mid-flight.
 *
 * It falls to `history` only once truly resolved: a `done` epic the operator has acknowledged, or a
 * terminal non-`done` status (`failed`/`abandoned`, which carry their own incident signal and need no
 * tick-off). Pure and read-only; projected at write time by the `plans` gateway (app/plan.ts) onto
 * `plans.list_bucket`. */
export function deriveEpicBucket(
  status: string,
  delivery: string | null | undefined,
  acknowledgedAt: string | null | undefined,
): "active" | "history" {
  if (EPIC_LIVE_STATUSES.includes(status)) return "active";
  if (status === "done") {
    // A still-`converging` epic is Active regardless of any (stray) acknowledged_at — it is genuinely
    // working and is not acknowledgeable, so it can never be ticked off mid-flight (fail-closed).
    if (delivery === "converging") return "active";
    // Otherwise `done` — landed or resolved-not-landed/poller-pending (`delivery = null`): stay Active
    // until the operator dismisses it, so a just-`done` epic never flickers into History.
    return (acknowledgedAt ?? null) === null ? "active" : "history";
  }
  return "history";
}

/** True iff an epic carries the operator "Dismiss" (acknowledge) affordance — a `done` epic whose
 * fan-out has RESOLVED (it is no longer `converging`): every slice PR has reached a terminal state,
 * whether all merged (`delivery = landed` — promote to main, then dismiss) or resolved-not-landed
 * (`delivery = null` — some abandoned/converged). This is the set of Active epics a tick-off may move
 * to History. A live (`planning`/`dispatched`) or still-`converging` epic is genuinely working —
 * nothing to tick off — so its Dismiss stays closed; a `failed`/`abandoned` epic is already in
 * History. The `acknowledgeEpic` operation guards on this (409 otherwise) and the gateway projects it
 * to `plans.ack_open` (1/0) so the page's `showWhenField` Dismiss button renders only for a resolved-
 * but-unacknowledged epic. */
export function epicIsAcknowledgeable(
  status: string,
  delivery: string | null | undefined,
): boolean {
  return status === "done" && delivery !== "converging";
}
