-- Delivery-graph incident mirroring (issue #931). A delivery-graph RUN's engine instance can park
-- on a technical incident exactly as a convergence loop can — and was just as invisible: `/status`
-- kept reporting `running` while nothing moved. These four columns are the delivery-side twin of
-- the PR incident mirror (017 + 126), written by the SAME `pollIncidents` pass and surfaced on the
-- `/status` delivery rows. All NULL when the run's instance has no active incident.
ALTER TABLE delivery_graph_runs ADD COLUMN incident_key TEXT;      -- engine incidentKey of the active incident parking this run's instance; NULL when none
ALTER TABLE delivery_graph_runs ADD COLUMN incident_type TEXT;     -- the active incident's errorType; NULL when none
ALTER TABLE delivery_graph_runs ADD COLUMN incident_message TEXT;  -- the active incident's errorMessage; NULL when none
ALTER TABLE delivery_graph_runs ADD COLUMN incident_since TEXT;    -- the active incident's creationTime (ISO); NULL when none

-- Mirror the new columns through the `delivery_units` aggregate (ADR 0006) so the
-- `delivery_graph_runs__units` compat VIEW stays row-for-row with the base table (as 120 did for
-- `auto_resolve_escalations`): add the columns, then re-create the delivery-graph sync triggers and
-- the compat VIEW with them.
ALTER TABLE delivery_units ADD COLUMN incident_key TEXT;
ALTER TABLE delivery_units ADD COLUMN incident_type TEXT;
ALTER TABLE delivery_units ADD COLUMN incident_message TEXT;
ALTER TABLE delivery_units ADD COLUMN incident_since TEXT;

DROP TRIGGER IF EXISTS delivery_graph_runs__du_ai;
CREATE TRIGGER delivery_graph_runs__du_ai AFTER INSERT ON delivery_graph_runs
BEGIN
  INSERT OR REPLACE INTO delivery_units (unit_id, kind, legacy_key, legacy_id, parent_unit_id, node_index, delivery_status, dispatch_status, process_key, process_definition_id, digest, status, side_effecting, node_count, human_node_count, side_effect_count, title, phase, phase_node_id, human_labels, acknowledged_at, auto_resolve_escalations, incident_key, incident_type, incident_message, incident_since, created_at, updated_at)
  VALUES ('delivery-graph:' || NEW.run_key, 'delivery-graph', NEW.run_key, NULL, NULL, NULL, CASE WHEN NEW.status = 'awaiting-approval' THEN 'requested' WHEN NEW.status = 'running' THEN 'running' WHEN NEW.status = 'done' THEN 'done' WHEN NEW.status = 'failed' THEN 'failed' WHEN NEW.status = 'abandoned' THEN 'abandoned' ELSE NULL END, CASE WHEN NEW.status IN ('awaiting-approval') THEN 'pending' WHEN NEW.status IN ('done', 'failed', 'abandoned') THEN 'settled' WHEN NEW.status IN ('running') THEN 'dispatched' ELSE NULL END, NEW.process_key, NEW.process_definition_id, NEW.digest, NEW.status, NEW.side_effecting, NEW.node_count, NEW.human_node_count, NEW.side_effect_count, NEW.title, NEW.phase, NEW.phase_node_id, NEW.human_labels, NEW.acknowledged_at, NEW.auto_resolve_escalations, NEW.incident_key, NEW.incident_type, NEW.incident_message, NEW.incident_since, NEW.created_at, NEW.updated_at);
END;

DROP TRIGGER IF EXISTS delivery_graph_runs__du_au;
CREATE TRIGGER delivery_graph_runs__du_au AFTER UPDATE ON delivery_graph_runs
BEGIN
  INSERT OR REPLACE INTO delivery_units (unit_id, kind, legacy_key, legacy_id, parent_unit_id, node_index, delivery_status, dispatch_status, process_key, process_definition_id, digest, status, side_effecting, node_count, human_node_count, side_effect_count, title, phase, phase_node_id, human_labels, acknowledged_at, auto_resolve_escalations, incident_key, incident_type, incident_message, incident_since, created_at, updated_at)
  VALUES ('delivery-graph:' || NEW.run_key, 'delivery-graph', NEW.run_key, NULL, NULL, NULL, CASE WHEN NEW.status = 'awaiting-approval' THEN 'requested' WHEN NEW.status = 'running' THEN 'running' WHEN NEW.status = 'done' THEN 'done' WHEN NEW.status = 'failed' THEN 'failed' WHEN NEW.status = 'abandoned' THEN 'abandoned' ELSE NULL END, CASE WHEN NEW.status IN ('awaiting-approval') THEN 'pending' WHEN NEW.status IN ('done', 'failed', 'abandoned') THEN 'settled' WHEN NEW.status IN ('running') THEN 'dispatched' ELSE NULL END, NEW.process_key, NEW.process_definition_id, NEW.digest, NEW.status, NEW.side_effecting, NEW.node_count, NEW.human_node_count, NEW.side_effect_count, NEW.title, NEW.phase, NEW.phase_node_id, NEW.human_labels, NEW.acknowledged_at, NEW.auto_resolve_escalations, NEW.incident_key, NEW.incident_type, NEW.incident_message, NEW.incident_since, NEW.created_at, NEW.updated_at);
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
  du.created_at AS created_at,
  du.updated_at AS updated_at,
  du.acknowledged_at AS acknowledged_at,
  du.auto_resolve_escalations AS auto_resolve_escalations,
  du.incident_key AS incident_key,
  du.incident_type AS incident_type,
  du.incident_message AS incident_message,
  du.incident_since AS incident_since
FROM delivery_units du
WHERE du.kind = 'delivery-graph';

