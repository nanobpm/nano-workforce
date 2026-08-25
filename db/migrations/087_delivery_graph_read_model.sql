-- Delivery-graph read model: DECLARE ONCE, compile to BOTH backends (ADR-0065, nano-ide#452), for the
-- ONE derived stepper (ADR 0006 §4b, issue #541 / S7).
--
-- Before §4b the delivery-graph surfaces rendered `delivery_graph_runs.phase` — a bare text projection
-- the user-task park poll (`pollDeliveryGraphPhase`) recomputes — on a DIFFERENT renderer from
-- feature's `pipeline` stepper. S7 collapses feature + delivery-graph onto the ONE canonical step axis
-- (app/stepAxis.ts, seeded from `STAGE_KEYS`) rendered by the ONE `pipeline` kind. This migration adds
-- the delivery-graph half: a `delivery_graph_read_model` VIEW that maps the run's lifecycle onto a
-- CONFIGURED `STAGE_KEYS` bracket (`stage`) with a render state (`stage_state`), plus a companion
-- `park_label` display column carrying the actionable "Parked on human node: <label>" text so promoting
-- the stepper does not drop the detail the plain Phase cell showed.
--
-- Every DERIVED column below is emitted VERBATIM from the ONE declaration in
-- app/deliveryGraphReadModel.ts — the member-PR rollup DDL from `deliveryGraphPrCounts.viewDdl()`, and
-- `stage`/`stage_state` from `deliveryGraphReadModel.sqlSelectFor(col, { baseAlias: "dg" })` — which
-- ALSO drive the runtime TS via `reduce`/`fnFor`. The two lowerings fall out of the same closed-DSL AST
-- and cannot diverge; a drift guard (app/deliveryGraphReadModel.test.ts) fails if this file stops
-- matching the declaration, and `assertRollupParity`/`assertReadModelParity` prove the SQL and TS
-- lowerings agree.
--
-- PER-SHAPE CORRELATION. A delivery-graph run has no aggregate `pr_key`; its downstream PRs attach via
-- `pull_requests.root_request_key = delivery_graph_runs.run_key`. The `delivery_graph_pr_counts` rollup
-- folds the member PRs (through `pull_requests__tracking.derived_status`, so an out-of-band-terminated
-- PR is not held in flight) grouped by `root_request_key`, and the read model LEFT JOINs it on
-- `dg.run_key = pc.root_request_key`. `prs_in_flight > 0` tempers a `running` run to `Converging`,
-- matching the shipped `deliveryOriginStage` (app/lineage.ts) — NOT a `process_key` join (that key is
-- reassigned to the downstream convergence/merge instances).
--
-- SEMANTICS. The status-classifying `stage`/`stage_state` read the terminal-folded `derived_status` off
-- the auto-provisioned `delivery_graph_runs__tracking` derived VIEW (ADR-0065), so a cancelled run
-- renders `Done`/`failed` instead of freezing at `Implementing`/`Converging`. Base columns stay aliased
-- identity pass-throughs (so the static pages↔schema contract guard sees the VIEW's columns), sourced
-- off `delivery_graph_runs__tracking`'s re-export of the base `delivery_graph_runs.*`; `status` is the
-- effective `COALESCE(derived_status, status)` so the pages' Active/History status filter tracks a
-- terminated run. `park_label` is a hand-authored DISPLAY column (D3 — display formatting is out of the
-- framework AST, so it carries no TS twin): the run's `phase` when it is parked on a human node
-- (`phase_node_id` set), else NULL.
--
-- Forward-only VIEW definition (DROP then CREATE). `delivery_graph_runs__tracking` is the managed VIEW
-- urban provisions at mount; SQLite does not validate a view body at CREATE time, so this migration
-- (which runs before that mount) is created fine and resolves once the managed VIEW exists. The runner
-- wraps each file in its own transaction, so this file must NOT contain BEGIN/COMMIT. Numbered after 085.

DROP VIEW IF EXISTS delivery_graph_read_model;
DROP VIEW IF EXISTS delivery_graph_pr_counts;

CREATE VIEW IF NOT EXISTS "delivery_graph_pr_counts" AS
SELECT
  "__urban_rollup_src"."root_request_key" AS "root_request_key",
  SUM(CASE WHEN COALESCE(((NOT COALESCE(("__urban_rollup_src"."root_request_key" IS NULL), 0)) AND (NOT COALESCE(COALESCE((COALESCE(("__urban_rollup_src"."derived_status" = 'converged'), 0) OR COALESCE(("__urban_rollup_src"."derived_status" = 'merged'), 0) OR COALESCE(("__urban_rollup_src"."derived_status" = 'abandoned'), 0)), 0), 0))), 0) THEN 1 ELSE 0 END) AS "prs_in_flight"
FROM "pull_requests__tracking" "__urban_rollup_src"
GROUP BY "__urban_rollup_src"."root_request_key";

CREATE VIEW delivery_graph_read_model AS
SELECT
  dg.run_key AS run_key,
  COALESCE(dg.derived_status, dg.status) AS status,
  dg.process_key AS process_key,
  dg.process_definition_id AS process_definition_id,
  dg.digest AS digest,
  dg.side_effecting AS side_effecting,
  dg.node_count AS node_count,
  dg.human_node_count AS human_node_count,
  dg.side_effect_count AS side_effect_count,
  dg.title AS title,
  dg.phase AS phase,
  dg.phase_node_id AS phase_node_id,
  dg.human_labels AS human_labels,
  dg.created_at AS created_at,
  dg.updated_at AS updated_at,
  CASE WHEN COALESCE(("dg"."derived_status" = 'done'), 0) THEN 'Done' WHEN COALESCE((COALESCE(("dg"."derived_status" = 'failed'), 0) OR COALESCE(("dg"."derived_status" = 'abandoned'), 0)), 0) THEN 'Done' WHEN COALESCE(("dg"."derived_status" = 'awaiting-approval'), 0) THEN 'Requested' WHEN COALESCE((COALESCE("pc"."prs_in_flight", 0) > 0), 0) THEN 'Converging' ELSE 'Implementing' END AS stage,
  CASE WHEN COALESCE(("dg"."derived_status" = 'done'), 0) THEN 'ok' WHEN COALESCE((COALESCE(("dg"."derived_status" = 'failed'), 0) OR COALESCE(("dg"."derived_status" = 'abandoned'), 0)), 0) THEN 'failed' ELSE NULL END AS stage_state,
  CASE WHEN dg.phase_node_id IS NOT NULL THEN dg.phase ELSE NULL END AS park_label
FROM delivery_graph_runs__tracking dg
LEFT JOIN delivery_graph_pr_counts pc ON dg.run_key = pc.root_request_key;
