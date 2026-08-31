// The `plan_read_model` per-row signals — DECLARED ONCE and compiled to BOTH backends via Urban's
// ADR-0065 reconciling-read-model primitive (`defineReadModel` + key-correlated rollup lookups,
// `@nanobpm/urban`, capability nano-ide#468 / `@nanobpm/urban@0.82.0`). The exemplar is
// app/featureReadModel.ts; this is its plan-family twin (issue #493, the sole remaining ADR-0065
// surface-#2 slice — nano-ide#452 step 2).
//
// Background (issues #171 → #298 → #412 → #439 → #503). The Epic surfaces render DERIVED per-row state
// off each `plans` row plus its slice-PR/wave aggregates: the delivery signal (`delivery`), the wave
// frontier (`wave_count`/`current_wave`), and the Active/History partition + operator tick-off
// (`list_bucket`/`ack_open`). None are ground truth: each is a pure function of the plan's own
// effective status + acknowledgement, correlated with the plan-family GROUP-BY rollups
// (app/planRollups.ts). 061/074/080 authored these TWICE — a SQL `CASE` inside the `plan_delivery` /
// `plan_read_model` VIEWs AND a TS oracle (`deriveDelivery`/`deriveEpicBucket`/`epicIsAcknowledgeable`,
// app/delivery.ts) — kept in lockstep by hand-written parity tests (drift surface #2, ADR-0065).
//
// This module closes surface #2 STRUCTURALLY: every derivation is expressed ONCE in Urban's closed
// expression DSL, and Urban compiles it to BOTH the SQLite VIEW select-list (`sqlSelectFor`, emitted
// verbatim into the superseding migration, drift-guarded) AND the runtime TS function (`fnFor`, the
// sole engine behind the `deriveDelivery`/`deriveEpicBucket`/`epicIsAcknowledgeable` adapters in
// app/delivery.ts). `assertReadModelParity` (app/planReadModel.test.ts) is now the framework-owned
// regression guard that the two lowerings agree.
//
// SCOPE. The GROUP-BY aggregates are single-sourced in app/planRollups.ts (`defineRollup`); this model
// CONSUMES their columns via key-correlated `LEFT JOIN <rollup> ON plan_key` lookups (D1's per-row
// half). The pre-formatted display strings (`delivery_label`, `wave_label`, the wave `bar`) stay
// hand-authored *display* columns over these derived structured columns (D3 — display formatting is
// out of the framework AST); they carry no TS twin, so no surface-#2 obligation. The epic's
// write-time domain phase (`epic_phase`, app/epicPhase.ts) is a PROVENANCE projection (each spine
// worker stamps its own BPMN element's phase) with no SQL twin — it is not a per-row function of the
// plan row, so it stays hand-authored and out of this declaration.

import { and, caseWhen, col, defineReadModel, type Expr, eq, gt, lit, not, or, type ReadModel, rcol, when } from "@nanobpm/urban";
import { deriveAckOpenFromTerminal, deriveListBucketFromTerminal, terminalStatusIn } from "./listBucket.ts";
import { PLAN_TERMINAL_STATUSES } from "./plan.ts";
import { planDeliveryCounts, planWaveProgress } from "./planRollups.ts";

/** The base table the read model reads: the auto-provisioned `plans__tracking` derived VIEW (ADR-0065,
 * urban 0.81.0), NOT the raw `plans` table. It re-exports `plans.*` plus a terminal-folded
 * `derived_status` (`abandoned` on an out-of-band-terminated instance, else the base `plans.status`),
 * so the Active/History bucket derivations below classify on ENGINE TRUTH and a cancelled epic drops
 * out of Active with no worker write (issue #503) — exactly as `feature_read_model` reads
 * `feature_runs__tracking`. */
export const PLAN_READ_MODEL_BASE_TABLE = "plans__tracking";

/** The base alias the managed VIEW gives `plans__tracking` — pinned so the emitted derived-column SQL
 * (`pl."col"`) matches the superseding migration exactly (the drift guard compares against this alias). */
export const PLAN_READ_MODEL_BASE_ALIAS = "pl";

/** The rollup-lookup aliases `rcol(...)` reads under — the `LEFT JOIN <rollup> <alias> ON plan_key`
 * targets. `dc` = `plan_delivery_counts` (slice-PR counts), `wp` = `plan_wave_progress` (wave
 * frontier). Pinned so the emitted SQL and the migration's hand-authored JOIN aliases agree. */
export const DELIVERY_COUNTS_LOOKUP = "dc";
export const WAVE_PROGRESS_LOOKUP = "wp";

/** The effective (terminal-folded) status column the bucket/ack derivations classify on — the tracking
 * VIEW's `derived_status`. Single source of truth for the name so the derivations can't drift from it. */
export const EFFECTIVE_STATUS_COLUMN = "derived_status";

/** The BASE `plans.status` column the delivery classification reads. `delivery` is only ever non-null
 * for a `done` epic, and `done` is already terminal (no reconciler derive edge re-writes it), so base
 * and effective status agree on the `= 'done'` gate; reading base `status` here keeps the `delivery`
 * column byte-identical to the retired `plan_delivery` VIEW (061) and to `deriveDelivery(plan.status,
 * …)`'s call sites, which pass the base status. */
const BASE_STATUS_COLUMN = "status";

const bs = col(BASE_STATUS_COLUMN);

/** The derived epic `delivery` signal — the byte-for-byte twin of the retired `plan_delivery` VIEW's
 * CASE (061) and of `deriveDelivery` (app/delivery.ts), now a per-row classification over the
 * `plan_delivery_counts` rollup lookup:
 *   - NULL   when the plan is not `done` OR opened no PRs (no positive signal yet), OR every PR is
 *            terminal but not all merged (resolved-not-landed — the `ELSE` arm).
 *   - 'converging' when ≥1 opened slice PR is still in flight (`prs_in_flight > 0`).
 *   - 'landed'     when every opened slice PR merged (`prs_merged = prs_opened`, `prs_in_flight = 0`).
 * The lookup's `prs_*` default to 0 on a LEFT-JOIN miss, so a plan with no `plan_delivery_counts` row
 * reads `prs_opened = 0` ⇒ NULL, exactly `COALESCE(c.prs_opened, 0) = 0`. */
const delivery: Expr = caseWhen(
  [
    when(or(not(eq(bs, lit("done"))), eq(rcol(DELIVERY_COUNTS_LOOKUP, "prs_opened"), lit(0))), lit(null)),
    when(gt(rcol(DELIVERY_COUNTS_LOOKUP, "prs_in_flight"), lit(0)), lit("converging")),
    when(eq(rcol(DELIVERY_COUNTS_LOOKUP, "prs_merged"), rcol(DELIVERY_COUNTS_LOOKUP, "prs_opened")), lit("landed")),
  ],
  lit(null),
);

/** The epic's "dismissable-terminal" predicate — terminal AND actually tick-off-able: the epic's
 * terminal-folded `derived_status` is in {@link PLAN_TERMINAL_STATUSES} (`done`/`failed`/`abandoned`)
 * AND its fan-out is NOT still `converging`. This is the epic-specific refinement the shared oracle
 * (app/listBucket.ts) takes: a `done`-but-still-`converging` epic is terminal by status yet must NOT be
 * dismissable mid-flight (a stray/premature ack must not drag it to History) — PRs/Delivery-Graphs have
 * no such mid-flight terminal, so their predicate is just "terminal". `not(eq(delivery, 'converging'))`
 * is the null-safe `delivery IS NOT 'converging'` (a NULL/`landed` delivery ⇒ resolved ⇒ dismissable)
 * under the shared "NULL → false" rule. */
const dismissableTerminal: Expr = and(
  terminalStatusIn(EFFECTIVE_STATUS_COLUMN, PLAN_TERMINAL_STATUSES),
  not(eq(delivery, lit("converging"))),
);

/** The Active/History partition (`deriveEpicBucket`, app/delivery.ts) — the ONE shared oracle
 * (app/listBucket.ts, issue #641) over the epic's {@link dismissableTerminal} predicate, so every
 * "Active …" grid partitions with the identical acknowledge-to-dismiss rule: `history` IFF the epic is
 * dismissable-terminal AND acknowledged; otherwise `active` (live `planning`/`dispatched` epics, a
 * `done`-but-still-`converging` epic — terminal but not dismissable mid-flight, so it stays active — and
 * the #641 gap this closes: a terminal-non-`done` `failed`/`abandoned` epic that is UNACKNOWLEDGED,
 * which before fell straight to History skipping the tick-off). Classifies on the terminal-folded
 * `derived_status` so a cancelled epic is handled on engine truth. */
const listBucket: Expr = deriveListBucketFromTerminal(dismissableTerminal);

/** The operator "Dismiss" (acknowledge) affordance flag (`epicIsAcknowledgeable` ∧ unacknowledged):
 * `1` iff the epic is {@link dismissableTerminal} and not yet acknowledged; else `0`. Shares the exact
 * predicate with {@link listBucket} (a row is dismissable precisely while it would still be `active` on
 * the terminal branch). Extended from `done`-only to the full terminal set for #641: a `failed`/
 * `abandoned` epic (whose `delivery` is always non-`converging`) is now dismissable too, so the
 * terminal-non-`done` arm of {@link listBucket} has a Dismiss affordance to move it to History —
 * mirroring features/PRs/DGs. */
const ackOpen: Expr = deriveAckOpenFromTerminal(dismissableTerminal);

/** The wave frontier columns — bare pass-throughs of the `plan_wave_progress` rollup lookup (a
 * taskless plan has no rollup row, so the LEFT-JOIN miss reads NULL, matching the workers' behaviour).
 * They are structured columns of THIS model so the thin display `wave_label` (migration) can format
 * `(current_wave + 1)/wave_count` over them without a TS twin. */
const waveCount: Expr = rcol(WAVE_PROGRESS_LOOKUP, "wave_count");
const currentWave: Expr = rcol(WAVE_PROGRESS_LOOKUP, "current_wave");

/** The keys of {@link planReadModel}'s DERIVED columns, in the order the superseding migration emits
 * them. Base columns are identity pass-throughs (not derivations) and are listed in the migration
 * directly; `delivery_label`/`wave_label` are hand-authored display columns (no TS twin). */
export const PLAN_READ_MODEL_DERIVED = ["delivery", "wave_count", "current_wave", "list_bucket", "ack_open"] as const;
export type PlanReadModelDerivedColumn = (typeof PLAN_READ_MODEL_DERIVED)[number];

/**
 * The declare-once `plan_read_model` derived columns. `selectBaseColumns: false` because the base
 * columns are plain identity pass-throughs enumerated in the migration (so the static pages↔schema
 * contract guard, which reads a VIEW's columns off an aliased select-list, sees them) — and because
 * the `plans` base row still carries the vestigial `list_bucket`/`ack_open` columns (#439), which a
 * `base.*` splat would collide with these derivations. This model owns only the five real DERIVATIONS;
 * both the migration VIEW (`sqlSelectFor`, drift-guarded) and the runtime TS oracle (`fnFor`, behind
 * app/delivery.ts) are generated from THIS single declaration, with the two rollup lookups supplying
 * the aggregate columns the per-row CASEs consume.
 */
export const planReadModel: ReadModel = defineReadModel({
  name: "plan_read_model",
  baseTable: PLAN_READ_MODEL_BASE_TABLE,
  selectBaseColumns: false,
  lookups: [
    {
      as: DELIVERY_COUNTS_LOOKUP,
      rollup: planDeliveryCounts,
      on: [{ base: "plan_key", rollup: "plan_key" }],
      defaults: { prs_opened: 0, prs_merged: 0, prs_in_flight: 0 },
    },
    {
      as: WAVE_PROGRESS_LOOKUP,
      rollup: planWaveProgress,
      on: [{ base: "plan_key", rollup: "plan_key" }],
    },
  ],
  derive: {
    delivery,
    wave_count: waveCount,
    current_wave: currentWave,
    list_bucket: listBucket,
    ack_open: ackOpen,
  },
});
