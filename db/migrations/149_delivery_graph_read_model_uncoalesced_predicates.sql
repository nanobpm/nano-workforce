-- Re-create the `delivery_graph_read_model` VIEW from the CURRENT `sqlSelectFor` output.
-- @nanobpm/urban 0.100.0 (nano-ide#625) stopped COALESCE-wrapping projection predicates inside
-- EXISTS/WHERE/CASE, so SQLite can use its indexes (e.g. the `merges` lookup behind
-- `pull_requests_read_model`). The derived columns are emitted VERBATIM from app/featureReadModel.ts,
-- app/deliveryGraphReadModel.ts, app/planReadModel.ts and app/pullRequestReadModel.ts; the base
-- pass-throughs, display columns, FROM/JOINs are unchanged from 112 / 146 / 100 / 138 respectively.
-- Semantics are unchanged (the declarations' NULL handling is preserved by the new lowering — the
-- FRAMEWORK PARITY GUARDs check SQL↔TS agreement). No BEGIN/COMMIT (the runner wraps each file).
-- Numbered after 147.

DROP VIEW IF EXISTS delivery_graph_read_model;

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
  CASE WHEN (("dg"."derived_status" = 'abandoned') AND (NOT COALESCE(("cx"."cancelled_at" IS NULL), 0))) THEN 'cancelled' ELSE "dg"."derived_status" END AS status,
  CASE WHEN ("dg"."derived_status" = 'done') THEN 'Done' WHEN (("dg"."derived_status" = 'failed') OR ("dg"."derived_status" = 'abandoned')) THEN 'Done' WHEN ("dg"."derived_status" = 'awaiting-approval') THEN 'Requested' WHEN (COALESCE("pc"."prs_in_flight", 0) > 0) THEN 'Converging' ELSE 'Implementing' END AS stage,
  CASE WHEN ("dg"."derived_status" = 'done') THEN 'ok' WHEN ("dg"."derived_status" = 'failed') THEN 'failed' ELSE NULL END AS stage_state,
  CASE WHEN ((("dg"."derived_status" = 'done') OR ("dg"."derived_status" = 'failed') OR ("dg"."derived_status" = 'abandoned')) AND ("dg"."acknowledged_at" = "dg"."acknowledged_at")) THEN 'history' ELSE 'active' END AS list_bucket,
  CASE WHEN ((("dg"."derived_status" = 'done') OR ("dg"."derived_status" = 'failed') OR ("dg"."derived_status" = 'abandoned')) AND (NOT COALESCE(COALESCE(("dg"."acknowledged_at" = "dg"."acknowledged_at"), 0), 0))) THEN 1 ELSE 0 END AS ack_open,
  "cx"."cancelled_by" AS cancelled_by,
  "cx"."cancelled_at" AS cancelled_at,
  "cx"."cancel_reason" AS cancel_reason,
  CASE WHEN dg.phase_node_id IS NOT NULL THEN dg.phase ELSE NULL END AS park_label
FROM delivery_graph_runs__tracking dg
LEFT JOIN delivery_graph_pr_counts pc ON dg.run_key = pc.root_request_key
LEFT JOIN delivery_graph_cancellations cx ON dg.process_key = cx.process_key;
