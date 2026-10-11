-- Re-create the `delivery_graph_read_model` VIEW so it re-exports the base column added by
-- 120_escalation_auto_resolutions.sql (`auto_resolve_escalations`). The read-model VIEW must pass
-- through EVERY base `delivery_graph_runs` column (the static pages↔schema contract guard +
-- app/deliveryGraphReadModel.test.ts DRIFT GUARD assert it), so adding a base column obliges a fresh
-- VIEW definition — 087/096 are immutable and cannot be edited in place.
--
-- Every DERIVED column below is emitted VERBATIM from the ONE declaration in
-- app/deliveryGraphReadModel.ts (`deliveryGraphReadModel.sqlSelectFor(col, { baseAlias: "dg" })`) —
-- the same closed-DSL AST that drives the runtime TS via `fnFor`, so the two lowerings cannot
-- diverge. This file is a mechanical re-emission of 096 with the one new base pass-through added;
-- the derived `stage`/`stage_state`/`list_bucket`/`ack_open`/`park_label` expressions are unchanged.
-- The drift guard now points at THIS migration (the latest VIEW definition).
--
-- Forward-only VIEW definition (DROP then CREATE), sourced off the managed
-- `delivery_graph_runs__tracking` re-export of the base table so a terminated run classifies on
-- ENGINE TRUTH. The runner wraps each file in its own transaction, so this file must NOT contain
-- BEGIN/COMMIT. Numbered after 120.

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
  dg.acknowledged_at AS acknowledged_at,
  dg.auto_resolve_escalations AS auto_resolve_escalations,
  CASE WHEN COALESCE(("dg"."derived_status" = 'done'), 0) THEN 'Done' WHEN COALESCE((COALESCE(("dg"."derived_status" = 'failed'), 0) OR COALESCE(("dg"."derived_status" = 'abandoned'), 0)), 0) THEN 'Done' WHEN COALESCE(("dg"."derived_status" = 'awaiting-approval'), 0) THEN 'Requested' WHEN COALESCE((COALESCE("pc"."prs_in_flight", 0) > 0), 0) THEN 'Converging' ELSE 'Implementing' END AS stage,
  CASE WHEN COALESCE(("dg"."derived_status" = 'done'), 0) THEN 'ok' WHEN COALESCE((COALESCE(("dg"."derived_status" = 'failed'), 0) OR COALESCE(("dg"."derived_status" = 'abandoned'), 0)), 0) THEN 'failed' ELSE NULL END AS stage_state,
  CASE WHEN COALESCE((COALESCE((COALESCE(("dg"."derived_status" = 'done'), 0) OR COALESCE(("dg"."derived_status" = 'failed'), 0) OR COALESCE(("dg"."derived_status" = 'abandoned'), 0)), 0) AND COALESCE(("dg"."acknowledged_at" = "dg"."acknowledged_at"), 0)), 0) THEN 'history' ELSE 'active' END AS list_bucket,
  CASE WHEN COALESCE((COALESCE((COALESCE(("dg"."derived_status" = 'done'), 0) OR COALESCE(("dg"."derived_status" = 'failed'), 0) OR COALESCE(("dg"."derived_status" = 'abandoned'), 0)), 0) AND (NOT COALESCE(COALESCE(("dg"."acknowledged_at" = "dg"."acknowledged_at"), 0), 0))), 0) THEN 1 ELSE 0 END AS ack_open,
  CASE WHEN dg.phase_node_id IS NOT NULL THEN dg.phase ELSE NULL END AS park_label
FROM delivery_graph_runs__tracking dg
LEFT JOIN delivery_graph_pr_counts pc ON dg.run_key = pc.root_request_key;
