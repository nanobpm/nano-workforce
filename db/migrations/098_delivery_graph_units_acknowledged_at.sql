-- Delivery Graphs: carry the new `acknowledged_at` dismissal stamp (095) through the `delivery_units`
-- aggregate (issue #641). Migration 095 added `acknowledged_at` to the base `delivery_graph_runs`
-- table, but its projection onto the ADR "declare-once" `delivery_units` aggregate (088-091) predates
-- the column: the delivery-graph sync triggers (089) never copied it and the `delivery_graph_runs__units`
-- compat VIEW (091) never re-exported it. That broke the aggregate's compat-view parity invariant
-- (`delivery_graph_runs__units` must be byte-identical to `delivery_graph_runs`), and — since the
-- aggregate is the S9 unified store the feature/epic surfaces already read `acknowledged_at`/`list_bucket`
-- from — left the delivery-graph unit rows without the dismissal stamp the other kinds carry.
--
-- This migration supersedes the two delivery-graph WRITE triggers (INSERT/UPDATE) to also project
-- `NEW.acknowledged_at`, re-creates the `delivery_graph_runs__units` compat VIEW to re-export it, and
-- backfills the stamp onto the existing aggregate rows (095's backfill fired the OLD trigger, which
-- dropped `acknowledged_at`, so the aggregate must be re-synced from the base once here). The feature
-- and epic triggers/views already project `acknowledged_at` (089/091) and are untouched; the DELETE
-- trigger is column-agnostic and is left as-is.
--
-- Migrations are forward-only and immutable once merged, so 089/091 are NOT edited — the triggers/VIEW
-- are DROPped and re-created here (numbered after 097). The runner wraps each file in its own
-- transaction — no BEGIN/COMMIT.

DROP TRIGGER IF EXISTS delivery_graph_runs__du_ai;
CREATE TRIGGER delivery_graph_runs__du_ai AFTER INSERT ON delivery_graph_runs
BEGIN
  INSERT OR REPLACE INTO delivery_units (unit_id, kind, legacy_key, legacy_id, parent_unit_id, node_index, delivery_status, dispatch_status, process_key, process_definition_id, digest, status, side_effecting, node_count, human_node_count, side_effect_count, title, phase, phase_node_id, human_labels, acknowledged_at, created_at, updated_at)
  VALUES ('delivery-graph:' || NEW.run_key, 'delivery-graph', NEW.run_key, NULL, NULL, NULL, CASE WHEN NEW.status = 'awaiting-approval' THEN 'requested' WHEN NEW.status = 'running' THEN 'running' WHEN NEW.status = 'done' THEN 'done' WHEN NEW.status = 'failed' THEN 'failed' WHEN NEW.status = 'abandoned' THEN 'abandoned' ELSE NULL END, CASE WHEN NEW.status IN ('awaiting-approval') THEN 'pending' WHEN NEW.status IN ('done', 'failed', 'abandoned') THEN 'settled' WHEN NEW.status IN ('running') THEN 'dispatched' ELSE NULL END, NEW.process_key, NEW.process_definition_id, NEW.digest, NEW.status, NEW.side_effecting, NEW.node_count, NEW.human_node_count, NEW.side_effect_count, NEW.title, NEW.phase, NEW.phase_node_id, NEW.human_labels, NEW.acknowledged_at, NEW.created_at, NEW.updated_at);
END;

DROP TRIGGER IF EXISTS delivery_graph_runs__du_au;
CREATE TRIGGER delivery_graph_runs__du_au AFTER UPDATE ON delivery_graph_runs
BEGIN
  INSERT OR REPLACE INTO delivery_units (unit_id, kind, legacy_key, legacy_id, parent_unit_id, node_index, delivery_status, dispatch_status, process_key, process_definition_id, digest, status, side_effecting, node_count, human_node_count, side_effect_count, title, phase, phase_node_id, human_labels, acknowledged_at, created_at, updated_at)
  VALUES ('delivery-graph:' || NEW.run_key, 'delivery-graph', NEW.run_key, NULL, NULL, NULL, CASE WHEN NEW.status = 'awaiting-approval' THEN 'requested' WHEN NEW.status = 'running' THEN 'running' WHEN NEW.status = 'done' THEN 'done' WHEN NEW.status = 'failed' THEN 'failed' WHEN NEW.status = 'abandoned' THEN 'abandoned' ELSE NULL END, CASE WHEN NEW.status IN ('awaiting-approval') THEN 'pending' WHEN NEW.status IN ('done', 'failed', 'abandoned') THEN 'settled' WHEN NEW.status IN ('running') THEN 'dispatched' ELSE NULL END, NEW.process_key, NEW.process_definition_id, NEW.digest, NEW.status, NEW.side_effecting, NEW.node_count, NEW.human_node_count, NEW.side_effect_count, NEW.title, NEW.phase, NEW.phase_node_id, NEW.human_labels, NEW.acknowledged_at, NEW.created_at, NEW.updated_at);
END;

DROP VIEW IF EXISTS delivery_graph_runs__units;
CREATE VIEW delivery_graph_runs__units AS
SELECT
  du.legacy_key AS run_key,
  du.process_key AS process_key,
  du.process_definition_id AS process_definition_id,
  du.digest AS digest,
  du.status AS status,
  du.side_effecting AS side_effecting,
  du.node_count AS node_count,
  du.human_node_count AS human_node_count,
  du.side_effect_count AS side_effect_count,
  du.title AS title,
  du.phase AS phase,
  du.phase_node_id AS phase_node_id,
  du.human_labels AS human_labels,
  du.acknowledged_at AS acknowledged_at,
  du.created_at AS created_at,
  du.updated_at AS updated_at
FROM delivery_units du
WHERE du.kind = 'delivery-graph';

-- Re-sync the stamp onto the existing aggregate rows (095's backfill fired the OLD, column-dropping
-- trigger). Keyed by the aggregate's `legacy_key` = the run's `run_key`.
UPDATE delivery_units
   SET acknowledged_at = (
     SELECT d.acknowledged_at FROM delivery_graph_runs d WHERE d.run_key = delivery_units.legacy_key
   )
 WHERE kind = 'delivery-graph';
