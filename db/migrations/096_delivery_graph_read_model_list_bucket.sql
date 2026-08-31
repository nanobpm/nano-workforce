-- Delivery-Graph read model: fold the acknowledge-to-dismiss `list_bucket`/`ack_open` derivations into
-- the `delivery_graph_read_model` VIEW (issue #641). SUPERSEDES 087's VIEW body — every DERIVED column
-- is emitted VERBATIM from the ONE declaration in app/deliveryGraphReadModel.ts, now extended with the
-- shared Active/History oracle (app/listBucket.ts). 087 is a MERGED, IMMUTABLE migration — never edited;
-- this is a NEW migration superseding its VIEW body (the same pattern by which 081 superseded 076).
--
-- WHY. Before #641 the Overview "Active Delivery Graphs" and delivery-graphs "In-flight" grids filtered
-- the derived VIEW's effective `status` on a base allowlist (`status IN ('awaiting-approval','running')`)
-- — so a terminal run dropped out of Active the instant it settled, with NO operator dismiss (the last
-- base-`status` allowlist #637 set out to retire). This VIEW adds a declared `list_bucket`
-- (active/history) + `ack_open` (Dismiss affordance) so a terminal run STAYS in `active` until
-- `acknowledged_at` is stamped (`acknowledgeDeliveryGraph`), then folds to `history`, uniformly with the
-- other three surfaces.
--
-- Every DERIVED column below is emitted VERBATIM from `deliveryGraphReadModel.sqlSelectFor(col,
-- { baseAlias: "dg" })` (which ALSO drives the runtime TS via `fnFor`); the member-PR rollup DDL is
-- unchanged from 087 and re-emitted from `deliveryGraphPrCounts.viewDdl()`. The drift guard
-- (app/deliveryGraphReadModel.test.ts) fails if this file stops matching the declaration, and
-- `assertRollupParity`/`assertReadModelParity` prove the SQL and TS lowerings agree.
--
-- SEMANTICS unchanged from 087 EXCEPT the two new derived columns: `stage`/`stage_state` still read the
-- terminal-folded `derived_status`; `park_label` is the same hand-authored display column; base columns
-- stay aliased identity pass-throughs; `status` is the effective `COALESCE(derived_status, status)`.
-- `acknowledged_at` (095) now passes through so the read model can classify on it.
--
-- Forward-only VIEW redefinition (DROP then CREATE). The runner wraps each file in its own transaction,
-- so this file must NOT contain BEGIN/COMMIT. Numbered after 095.

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
  CASE WHEN COALESCE(("dg"."derived_status" = 'done'), 0) THEN 'Done' WHEN COALESCE((COALESCE(("dg"."derived_status" = 'failed'), 0) OR COALESCE(("dg"."derived_status" = 'abandoned'), 0)), 0) THEN 'Done' WHEN COALESCE(("dg"."derived_status" = 'awaiting-approval'), 0) THEN 'Requested' WHEN COALESCE((COALESCE("pc"."prs_in_flight", 0) > 0), 0) THEN 'Converging' ELSE 'Implementing' END AS stage,
  CASE WHEN COALESCE(("dg"."derived_status" = 'done'), 0) THEN 'ok' WHEN COALESCE((COALESCE(("dg"."derived_status" = 'failed'), 0) OR COALESCE(("dg"."derived_status" = 'abandoned'), 0)), 0) THEN 'failed' ELSE NULL END AS stage_state,
  CASE WHEN COALESCE((COALESCE((COALESCE(("dg"."derived_status" = 'done'), 0) OR COALESCE(("dg"."derived_status" = 'failed'), 0) OR COALESCE(("dg"."derived_status" = 'abandoned'), 0)), 0) AND COALESCE(("dg"."acknowledged_at" = "dg"."acknowledged_at"), 0)), 0) THEN 'history' ELSE 'active' END AS list_bucket,
  CASE WHEN COALESCE((COALESCE((COALESCE(("dg"."derived_status" = 'done'), 0) OR COALESCE(("dg"."derived_status" = 'failed'), 0) OR COALESCE(("dg"."derived_status" = 'abandoned'), 0)), 0) AND (NOT COALESCE(COALESCE(("dg"."acknowledged_at" = "dg"."acknowledged_at"), 0), 0))), 0) THEN 1 ELSE 0 END AS ack_open,
  CASE WHEN dg.phase_node_id IS NOT NULL THEN dg.phase ELSE NULL END AS park_label
FROM delivery_graph_runs__tracking dg
LEFT JOIN delivery_graph_pr_counts pc ON dg.run_key = pc.root_request_key;
