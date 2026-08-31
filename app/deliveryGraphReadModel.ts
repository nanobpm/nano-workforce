// app/deliveryGraphReadModel.ts — the delivery-graph progress projection onto the canonical step axis
// (ADR 0006 §4b, S7). DECLARED ONCE and compiled to BOTH backends via Urban's ADR-0065 primitives
// (`defineRollup` + `defineReadModel`, `@nanobpm/urban`), exactly like the feature/plan read models
// (app/featureReadModel.ts, app/planReadModel.ts are the exemplars).
//
// WHAT S7 UNIFIES. Before §4b the delivery-graph surface rendered `delivery_graph_runs.phase` — a bare
// text projection the user-task park poll (`pollDeliveryGraphPhase` → `deriveDeliveryPhase`) recomputes
// ("Running" / "Parked on human node: <label>" / "Completed" / "Failed") — on a DIFFERENT renderer from
// feature's `pipeline` stepper. S7 collapses feature + delivery-graph onto the ONE step axis
// (app/stepAxis.ts) rendered by the ONE `pipeline` kind. This model supplies the delivery-graph half:
// the `pipeline` column's `activeField` (`stage`, a `STAGE_KEYS` value) and `stateField` (`stage_state`)
// derived from the run's lifecycle, with the actionable park text carried alongside on a companion
// `park_label` field (so promoting the stepper does not drop the `Parked on human node: <label>` detail
// the plain Phase cell showed today).
//
// PER-SHAPE CORRELATION (§4b §241-278, S7 rollout §558-605). A delivery-graph run has NO aggregate
// `pr_key`; its downstream PRs attach via `pull_requests.root_request_key = delivery_graph_runs.run_key`
// (`app/lineage.ts` `collectRootPrs`). So this model reads the run row and, via the
// `delivery_graph_pr_counts` rollup keyed on `root_request_key`, whether any member PR is still in
// flight — the correlated-PR signal that tempers a `running` run to `Converging` (matching the shipped
// `deliveryOriginStage`, app/lineage.ts). This is NOT a `process_key` join: `pull_requests.process_key`
// is reassigned downstream (convergence, then merge), so it is not the run's identity.
//
// LIFECYCLE-STAGE FIDELITY, STATELESS COARSE KEY (§4b §413-449). `delivery_graph_runs` stores no stage
// column (only `phase`/park metadata, whose values like "Running" are NOT `STAGE_KEYS`), and at S7 a
// running node with no open user task exposes only a generic `Running` with no node id. So the `stage`
// is derived STATELESSLY from the run's current effective status + the member-PR-in-flight signal on
// every read (nothing is held; the read model persists no stage key), mapped onto a CONFIGURED
// `STAGE_KEYS` bracket — never a fabricated cell position or an unconfigured `activeField` label:
//   - terminal `done`               → `Done`,  state `ok`     (settles outright; does not wait on PRs).
//   - terminal `failed`/`abandoned` → `Done`,  state `failed` (the axis tail bracket).
//   - `awaiting-approval` (reserved, pre-dispatch legacy rows) → `Requested` (the initial bracket).
//   - `running` with a member PR still in flight → `Converging`.
//   - `running` otherwise (dispatch begun, no PR frontier) → `Implementing` (the deterministic initial
//     value for a freshly-running graph, §433).
// At S7 a graph collapses to this ONE coarse run-level step: `delivery_graph_runs` stores a single
// `phase` per run, not a per-branch topology, so the least-advanced-active frontier reduction
// (app/stepAxis.ts `reduceFrontier`) is DEFINED but not yet computable from this source — the genuine
// per-branch reduction is deferred to S8's element-instance read model. A single-track feature and a
// single-step graph both reduce trivially to their one branch.

import { and, caseWhen, col, countWhere, defineReadModel, defineRollup, type Expr, eq, fromTable, gt, isNotNull, lit, not, or, type ReadModel, type Rollup, rcol, when } from "@nanobpm/urban";
import { DELIVERY_GRAPH_TERMINAL_STATUSES } from "./deliveryGraphRun.ts";
import { TERMINAL_STATUSES } from "./deliveryStatuses.ts";
import { deriveAckOpenExpr, deriveListBucketExpr } from "./listBucket.ts";
import { PR_TRACKING_RELATION } from "./planRollups.ts";

/** The slice-PR relation the member-PR rollup folds over: the auto-provisioned
 * `pull_requests__tracking` derived VIEW (ADR-0065), NOT the raw `pull_requests` table — so a member PR
 * that was terminated out of band reads its terminal-folded `derived_status` (`abandoned`) and is not
 * held in the live frontier (§4b S7 rollout §558-562). Re-exported from app/planRollups.ts — the ONE
 * canonical declaration of the tracking-relation name — so this model shares that single source rather
 * than reintroducing a drift surface if the relation is ever renamed. */
export { PR_TRACKING_RELATION };

/** The delivery-graph member-PR rollup: one row per `root_request_key` with the single count the
 * `Implementing`→`Converging` temper reads — how many attached PRs are still IN FLIGHT (their
 * terminal-folded `derived_status` is NOT in {@link TERMINAL_STATUSES}; a NULL status is not terminal,
 * so a DB desync counts as in flight rather than wrongly settling the run). Keyed on `root_request_key`
 * so the read-model lookup joins `delivery_graph_runs.run_key = root_request_key` (the per-shape
 * correlation contract). The `isNotNull(root_request_key)` guard keeps unrooted PRs (their own roots)
 * out of every run's count. */
export const deliveryGraphPrCounts: Rollup = defineRollup({
  name: "delivery_graph_pr_counts",
  source: fromTable(PR_TRACKING_RELATION),
  groupBy: ["root_request_key"],
  aggregates: {
    prs_in_flight: countWhere(
      and(
        isNotNull(col("root_request_key")),
        not(or(...TERMINAL_STATUSES.map((s) => eq(col("derived_status"), lit(s))))),
      ),
    ),
  },
});

/** Every delivery-graph rollup, in managed-VIEW dependency order. The migration emits their VIEW DDL in
 * this order; the parity guard iterates it. */
export const DELIVERY_GRAPH_ROLLUPS: readonly Rollup[] = [deliveryGraphPrCounts];

/** The base table the read model reads: the auto-provisioned `delivery_graph_runs__tracking` derived
 * VIEW (ADR-0065), NOT the raw `delivery_graph_runs` table. It re-exports `delivery_graph_runs.*` plus a
 * terminal-folded `derived_status` (an out-of-band-terminated run reads `failed` per the
 * `instanceTracking` `onTerminated` edge, else the base `status` — which `pollDeliveryGraphPhase` owns
 * the `COMPLETED → done` reconciliation for). The status-classifying derivation reads `derived_status`,
 * so a terminated run renders `Done` instead of freezing at `Implementing`/`Converging`. */
export const DELIVERY_GRAPH_READ_MODEL_BASE_TABLE = "delivery_graph_runs__tracking";

/** The base alias the managed VIEW gives `delivery_graph_runs__tracking` — pinned so the emitted
 * derived-column SQL (`dg."col"`) matches the migration exactly (the drift guard compares this alias). */
export const DELIVERY_GRAPH_READ_MODEL_BASE_ALIAS = "dg";

/** The rollup-lookup alias `rcol(...)` reads under — the `LEFT JOIN delivery_graph_pr_counts pc ON
 * dg.run_key = pc.root_request_key` target. Pinned so the emitted SQL and the migration's JOIN agree. */
export const PR_COUNTS_LOOKUP = "pc";

/** The effective (terminal-folded) status column the derivation classifies on — the tracking VIEW's
 * `derived_status`. Single source of truth for the name so the derivation can't drift from it. */
export const EFFECTIVE_STATUS_COLUMN = "derived_status";

const ds = col(EFFECTIVE_STATUS_COLUMN);

/** Whether a member PR of the run is still in flight — `prs_in_flight > 0` on the rollup lookup (0 on a
 * LEFT-JOIN miss, so a run with no attached PRs reads not-in-flight). Tempers a `running` run to
 * `Converging`, matching the shipped `deliveryOriginStage` (app/lineage.ts). */
const memberPrInFlight: Expr = gt(rcol(PR_COUNTS_LOOKUP, "prs_in_flight"), lit(0));

/**
 * The derived `stage` — a CONFIGURED `STAGE_KEYS` value (never a raw `phase` string), from the stateless
 * coarse-key rule (see the module header). Terminal statuses settle the step outright (before the PR
 * check), so `done` does not block on an open PR; a live `running` frontier with a member PR in flight
 * reads `Converging`, else `Implementing` (the deterministic initial value for a freshly-running graph).
 * `awaiting-approval` (reserved legacy pre-dispatch rows) maps to the initial `Requested` bracket.
 */
const stage: Expr = caseWhen(
  [
    when(eq(ds, lit("done")), lit("Done")),
    when(or(eq(ds, lit("failed")), eq(ds, lit("abandoned"))), lit("Done")),
    when(eq(ds, lit("awaiting-approval")), lit("Requested")),
    when(memberPrInFlight, lit("Converging")),
  ],
  lit("Implementing"),
);

/**
 * The active step's render state in the `pipeline` column's vocabulary (`ok`/`failed`/`blocked`/null):
 * a `done` graph is a success terminal (`ok`), a `failed`/`abandoned` graph is a failed terminal
 * (`failed`), else in progress (`null`). A delivery-graph run has no `blocked` terminal in its lifecycle
 * union, so that tier never arises here. Reuses the canonical terminal tiers (app/stepAxis.ts).
 */
const stageState: Expr = caseWhen(
  [
    when(eq(ds, lit("done")), lit("ok")),
    when(or(eq(ds, lit("failed")), eq(ds, lit("abandoned"))), lit("failed")),
  ],
  lit(null),
);

/** The keys of {@link deliveryGraphReadModel}'s DERIVED columns, in the order the migration emits them.
 * Base columns are identity pass-throughs (listed in the migration directly); `park_label` is a
 * hand-authored display column over the base `phase`/`phase_node_id` (no TS twin). `list_bucket`/
 * `ack_open` are the acknowledge-to-dismiss partition + Dismiss-affordance flag (issue #641). */
export const DELIVERY_GRAPH_READ_MODEL_DERIVED = ["stage", "stage_state", "list_bucket", "ack_open"] as const;
export type DeliveryGraphReadModelDerivedColumn = (typeof DELIVERY_GRAPH_READ_MODEL_DERIVED)[number];

/** The Active/History partition — `history` IFF the run is terminal AND acknowledged, else `active`
 * (live runs + terminal-but-UNACKNOWLEDGED runs that stay actionable until dismissed). The ONE shared
 * oracle (app/listBucket.ts, issue #641) parameterised by {@link DELIVERY_GRAPH_TERMINAL_STATUSES}, so
 * this grid's activeness predicate is byte-for-byte the same rule Features/Epics/PRs use — retiring the
 * `status IN ('awaiting-approval','running')` allowlist the pages filtered before. */
const listBucket: Expr = deriveListBucketExpr(EFFECTIVE_STATUS_COLUMN, DELIVERY_GRAPH_TERMINAL_STATUSES);

/** The operator "Dismiss" affordance flag — `1` IFF the run is terminal AND not yet acknowledged (so
 * the page's `showWhenField` Dismiss button renders only for a terminal-but-unacknowledged run), else
 * `0`. */
const ackOpen: Expr = deriveAckOpenExpr(EFFECTIVE_STATUS_COLUMN, DELIVERY_GRAPH_TERMINAL_STATUSES);

/**
 * The declare-once `delivery_graph_read_model` derived columns. `selectBaseColumns: false` because the
 * base columns are plain identity pass-throughs enumerated in the migration (so the static pages↔schema
 * contract guard, which reads a VIEW's columns off an aliased select-list, sees them). Both the
 * migration VIEW (`sqlSelectFor`, drift-guarded) and the runtime TS oracle (`fnFor`) are generated from
 * THIS single declaration; the member-PR rollup lookup supplies the in-flight signal the CASE consumes.
 */
export const deliveryGraphReadModel: ReadModel = defineReadModel({
  name: "delivery_graph_read_model",
  baseTable: DELIVERY_GRAPH_READ_MODEL_BASE_TABLE,
  selectBaseColumns: false,
  lookups: [
    {
      as: PR_COUNTS_LOOKUP,
      rollup: deliveryGraphPrCounts,
      on: [{ base: "run_key", rollup: "root_request_key" }],
      defaults: { prs_in_flight: 0 },
    },
  ],
  derive: {
    stage,
    stage_state: stageState,
    list_bucket: listBucket,
    ack_open: ackOpen,
  },
});
