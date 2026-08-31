// Canonical PR-terminal / epic-delivery derivation, extracted from `service.ts` so that the
// lineage read-projection (`app/lineage.ts`) can reuse `deriveDelivery`/`TERMINAL_STATUSES`
// without importing `service.ts` — which imports `pollLineage` back from `lineage.ts` and would
// otherwise form a `service.ts` ↔ `lineage.ts` module cycle (fragile in ESM). This is the single
// source of truth for both; `service.ts` re-uses it and remains free to import `pollLineage`.
//
// ADR-0065 / issue #493. `deriveDelivery`/`deriveEpicBucket`/`epicIsAcknowledgeable` are no longer
// hand-authored oracles: they are now THIN ADAPTERS over the ONE `plan_read_model` declaration
// (app/planReadModel.ts) and the `plan_delivery_counts` rollup (app/planRollups.ts). Each routes
// through the framework's runtime backend — `planDeliveryCounts.reduce` (the TS group-reduce) for the
// slice-PR counts, and `planReadModel.evaluate` (the TS derivation) for the per-row `delivery` /
// `list_bucket` / `ack_open` signals — so these façades and the superseding SQLite VIEWs (migrations
// 082/083) compute byte-identical values by construction, guarded by `assertReadModelParity` /
// `assertRollupParity` (app/planReadModel.test.ts). Only the pre-formatted `label` display string is
// still assembled here (D3 — display formatting stays out of the framework AST).

import { TERMINAL_STATUSES } from "./deliveryStatuses.ts";
import {
  DELIVERY_COUNTS_LOOKUP,
  EFFECTIVE_STATUS_COLUMN,
  planReadModel,
  WAVE_PROGRESS_LOOKUP,
} from "./planReadModel.ts";
import { PR_TRACKING_RELATION, planDeliveryCounts } from "./planRollups.ts";

/** The synthetic correlation key threaded through the adapters: the base row's `plan_key` and each
 * synthesised slice `plan_tasks`/`plan_delivery_counts` row share this value so the compiled rollup
 * lookup / group-reduce correlate exactly as they do on real rows (mirrors app/stage.ts `SELF_KEY`). */
const SELF_KEY = "self";

/** The PR statuses that are TERMINAL for delivery — re-exported from the canonical leaf module
 * (app/deliveryStatuses.ts) that BOTH this façade's consumers and the `plan_delivery_counts` rollup
 * (app/planRollups.ts) read, so the SQL VIEW counts and the TS adapters can never drift. `converged`
 * is terminal only in review-only mode (AUTO_MERGE off); with auto-merge on, a converged PR
 * transitions into the merge stage and lands as `merged`. The status endpoint and the cancel guard
 * both key off this set. */
export { TERMINAL_STATUSES };

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
  // Lower the caller's per-slice PR statuses into the two LEAF relations the `plan_delivery_counts`
  // rollup reduces over (`plan_tasks` LEFT JOIN `pull_requests__tracking`): one opened slice per PR
  // status. Callers already resolve the PR's terminal-folded `derived_status` (service.ts reads it via
  // `prsTracking`), so it is fed under the tracking relation's `derived_status` column — the SAME
  // column the managed VIEW joins — and the framework group-reduce folds the SAME three counts
  // (`prs_opened`/`prs_merged`/`prs_in_flight`) the VIEW does; a missing/dangling PR status counts as
  // in-flight, never false-`landed`.
  const taskRows = prStatuses.map((_, i) => ({ plan_key: SELF_KEY, pr_key: `pr${i}`, wave: null, status: "opened" }));
  const prRows = prStatuses.map((s, i) => ({ pr_key: `pr${i}`, derived_status: s }));
  const [counts] = planDeliveryCounts.reduce({ plan_tasks: taskRows, [PR_TRACKING_RELATION]: prRows });
  const prsOpened = Number(counts?.prs_opened ?? 0);
  const prsMerged = Number(counts?.prs_merged ?? 0);
  const prsInFlight = Number(counts?.prs_in_flight ?? 0);

  // Derive the `delivery` signal from the ONE `plan_read_model` declaration, feeding the folded counts
  // as the `plan_delivery_counts` lookup's single candidate row (the TS twin of the VIEW's LEFT JOIN).
  const raw = planReadModel.evaluate(
    { plan_key: SELF_KEY, status: planStatus, [EFFECTIVE_STATUS_COLUMN]: planStatus, acknowledged_at: null },
    undefined,
    { [DELIVERY_COUNTS_LOOKUP]: counts ? [counts] : [], [WAVE_PROGRESS_LOOKUP]: [] },
  ).delivery;
  const delivery: Delivery | null = raw === "converging" || raw === "landed" ? raw : null;

  // The pre-formatted human label stays hand-authored here (D3 — display formatting is out of the
  // framework AST); it mirrors the `plan_read_model` VIEW's `delivery_label` display column (083).
  let label: string | null = null;
  if (delivery === "converging") label = `${prsMerged}/${prsOpened} slices merged, ${prsInFlight} converging`;
  else if (delivery === "landed") label = `${prsOpened}/${prsOpened} slices merged`;
  return { delivery, label, prsOpened, prsMerged, prsInFlight };
}

/** The `plan.status` values that mean the epic's fan-out lifecycle is still LIVE — the planner is
 * decomposing (`planning`) or the fleet is implementing (`dispatched`). Both are unambiguously
 * in-flight, so an epic in either status is always in the Active bucket regardless of `delivery`. */
export const EPIC_LIVE_STATUSES = ["planning", "dispatched"] as const;

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
 * It falls to `history` only once truly resolved AND acknowledged: any TERMINAL epic — `done`,
 * `failed`, or `abandoned` — that the operator has dismissed (issue #641 made this uniform; before it,
 * a `failed`/`abandoned` epic dropped straight to History with no tick-off). An unacknowledged terminal
 * epic of ANY terminal status stays Active until dismissed. Pure and read-only; projected at write time
 * by the `plans` gateway (app/plan.ts) onto `plans.list_bucket`. */
export function deriveEpicBucket(
  status: string,
  delivery: string | null | undefined,
  acknowledgedAt: string | null | undefined,
): "active" | "history" {
  const raw = evalEpicRow(status, delivery, acknowledgedAt).list_bucket;
  return raw === "active" ? "active" : "history";
}

/** True iff an epic carries the operator "Dismiss" (acknowledge) affordance — a TERMINAL epic whose
 * fan-out has RESOLVED (it is no longer `converging`): a `done` epic whose every slice PR reached a
 * terminal state (all merged, `delivery = landed` — promote to main, then dismiss; or resolved-not-
 * landed, `delivery = null` — some abandoned/converged), OR a `failed`/`abandoned` epic (whose
 * `delivery` is inherently non-`converging`, so it is dismissable outright — issue #641). This is the
 * set of Active epics a tick-off may move to History. A live (`planning`/`dispatched`) or still-
 * `converging` epic is genuinely working — nothing to tick off — so its Dismiss stays closed. The
 * `acknowledgeEpic` operation guards on this (409 otherwise) and the gateway projects it to
 * `plans.ack_open` (1/0) so the page's `showWhenField` Dismiss button renders only for a resolved-but-
 * unacknowledged epic. */
export function epicIsAcknowledgeable(
  status: string,
  delivery: string | null | undefined,
): boolean {
  // The `ack_open` derivation folds in the `acknowledged_at IS NULL` gate; evaluate it with a null
  // acknowledgement to isolate the "acknowledgeABLE" predicate (`done` ∧ resolved) from "ack OPEN".
  return evalEpicRow(status, delivery, null).ack_open === 1;
}

/** Evaluate the `plan_read_model` per-row derivations (`list_bucket`/`ack_open`) for an epic whose
 * effective status, already-computed `delivery`, and acknowledgement the caller supplies. The model
 * recomputes `delivery` internally from its `plan_delivery_counts` lookup + base status, so — the twin
 * of app/stage.ts's `openTaskRows` synthesis — we SYNTHESISE the lookup row + base status that make the
 * model's internal `delivery` equal the passed value: `converging`/`landed` need a `done` base status
 * with an in-flight / all-merged count row; a null/other `delivery` needs an empty count (`prs_opened =
 * 0` ⇒ the model's first CASE arm ⇒ null). The status-classifying arms read the effective status under
 * `derived_status`, so the caller's `status` is fed there verbatim. */
function evalEpicRow(
  status: string,
  delivery: string | null | undefined,
  acknowledgedAt: string | null | undefined,
): Record<string, unknown> {
  const merged = delivery === "landed";
  const inFlight = delivery === "converging";
  const opened = merged || inFlight;
  const dcRow = {
    plan_key: SELF_KEY,
    prs_opened: opened ? 1 : 0,
    prs_merged: merged ? 1 : 0,
    prs_in_flight: inFlight ? 1 : 0,
  };
  return planReadModel.evaluate(
    {
      plan_key: SELF_KEY,
      // Force the model's internal `delivery` to the passed value: a `done` base status enables the
      // non-null arms for converging/landed; any status with a zero-opened count folds to null.
      status: opened ? "done" : status,
      [EFFECTIVE_STATUS_COLUMN]: status,
      acknowledged_at: acknowledgedAt ?? null,
    },
    undefined,
    { [DELIVERY_COUNTS_LOOKUP]: [dcRow], [WAVE_PROGRESS_LOOKUP]: [] },
  );
}
