-- Re-create the `delivery_graph_read_model` VIEW for PR #996 review: only a COMMITTED operator
-- cancellation (migration 145's `run_cancellations.committed`) promotes the terminated edge
-- (`abandoned`) to `cancelled`. A provisional cancellation row whose engine cancel was never
-- confirmed (a refused attempt's leftover, or a retry over an already-terminated run) must NOT
-- re-label the run or re-attribute the termination, so the `delivery_graph_cancellations` rollup
-- folds only rows with `committed = 1` (rows pre-dating the flag default to committed).
--
-- Every DERIVED column below is emitted VERBATIM from the ONE declaration in
-- app/deliveryGraphReadModel.ts (`sqlSelectFor(col, { baseAlias: "dg" })`); the rollup VIEWs verbatim
-- from `rollup.viewDdl()`. The drift guard (app/deliveryGraphReadModel.test.ts) points at THIS
-- migration. 144 is immutable, so this is a fresh forward-only DROP+CREATE. No BEGIN/COMMIT (the
-- runner wraps it).

DROP VIEW IF EXISTS delivery_graph_read_model;
DROP VIEW IF EXISTS delivery_graph_pr_counts;
DROP VIEW IF EXISTS delivery_graph_cancellations;

CREATE VIEW IF NOT EXISTS "delivery_graph_pr_counts" AS
SELECT
  "__urban_rollup_src"."root_request_key" AS "root_request_key",
  SUM(CASE WHEN COALESCE(((NOT COALESCE(("__urban_rollup_src"."root_request_key" IS NULL), 0)) AND (NOT COALESCE(COALESCE((COALESCE(("__urban_rollup_src"."derived_status" = 'converged'), 0) OR COALESCE(("__urban_rollup_src"."derived_status" = 'merged'), 0) OR COALESCE(("__urban_rollup_src"."derived_status" = 'abandoned'), 0)), 0), 0))), 0) THEN 1 ELSE 0 END) AS "prs_in_flight"
FROM "pull_requests__tracking" "__urban_rollup_src"
GROUP BY "__urban_rollup_src"."root_request_key";

CREATE VIEW IF NOT EXISTS "delivery_graph_cancellations" AS
SELECT
  "__urban_rollup_src"."process_key" AS "process_key",
  MIN(CASE WHEN COALESCE(("__urban_rollup_src"."committed" = 1), 0) THEN "__urban_rollup_src"."cancel_reason" END) AS "cancel_reason",
  MIN(CASE WHEN COALESCE(("__urban_rollup_src"."committed" = 1), 0) THEN "__urban_rollup_src"."cancelled_at" END) AS "cancelled_at",
  MIN(CASE WHEN COALESCE(("__urban_rollup_src"."committed" = 1), 0) THEN "__urban_rollup_src"."cancelled_by" END) AS "cancelled_by"
FROM "run_cancellations" "__urban_rollup_src"
GROUP BY "__urban_rollup_src"."process_key";

CREATE VIEW delivery_graph_read_model AS
SELECT
  dg.run_key AS run_key,
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
  dg.incident_key AS incident_key,
  dg.incident_type AS incident_type,
  dg.incident_message AS incident_message,
  dg.incident_since AS incident_since,
  CASE WHEN COALESCE((COALESCE(("dg"."derived_status" = 'abandoned'), 0) AND (NOT COALESCE(("cx"."cancelled_at" IS NULL), 0))), 0) THEN 'cancelled' ELSE "dg"."derived_status" END AS status,
  CASE WHEN COALESCE(("dg"."derived_status" = 'done'), 0) THEN 'Done' WHEN COALESCE((COALESCE(("dg"."derived_status" = 'failed'), 0) OR COALESCE(("dg"."derived_status" = 'abandoned'), 0)), 0) THEN 'Done' WHEN COALESCE(("dg"."derived_status" = 'awaiting-approval'), 0) THEN 'Requested' WHEN COALESCE((COALESCE("pc"."prs_in_flight", 0) > 0), 0) THEN 'Converging' ELSE 'Implementing' END AS stage,
  CASE WHEN COALESCE(("dg"."derived_status" = 'done'), 0) THEN 'ok' WHEN COALESCE(("dg"."derived_status" = 'failed'), 0) THEN 'failed' ELSE NULL END AS stage_state,
  CASE WHEN COALESCE((COALESCE((COALESCE(("dg"."derived_status" = 'done'), 0) OR COALESCE(("dg"."derived_status" = 'failed'), 0) OR COALESCE(("dg"."derived_status" = 'abandoned'), 0)), 0) AND COALESCE(("dg"."acknowledged_at" = "dg"."acknowledged_at"), 0)), 0) THEN 'history' ELSE 'active' END AS list_bucket,
  CASE WHEN COALESCE((COALESCE((COALESCE(("dg"."derived_status" = 'done'), 0) OR COALESCE(("dg"."derived_status" = 'failed'), 0) OR COALESCE(("dg"."derived_status" = 'abandoned'), 0)), 0) AND (NOT COALESCE(COALESCE(("dg"."acknowledged_at" = "dg"."acknowledged_at"), 0), 0))), 0) THEN 1 ELSE 0 END AS ack_open,
  "cx"."cancelled_by" AS cancelled_by,
  "cx"."cancelled_at" AS cancelled_at,
  "cx"."cancel_reason" AS cancel_reason,
  CASE WHEN dg.phase_node_id IS NOT NULL THEN dg.phase ELSE NULL END AS park_label
FROM delivery_graph_runs__tracking dg
LEFT JOIN delivery_graph_pr_counts pc ON dg.run_key = pc.root_request_key
LEFT JOIN delivery_graph_cancellations cx ON dg.process_key = cx.process_key;
