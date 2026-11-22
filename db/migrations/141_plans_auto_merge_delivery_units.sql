-- Issue #1007 (PR #1010 review): mirror the epic merge policy `plans.auto_merge` (140) through the
-- `delivery_units` aggregate (ADR 0006), so the `plans__units` compat VIEW stays row-for-row equal to
-- its base table (parity-tested in app/deliveryUnit.test.ts). `delivery_units` ALREADY carries an
-- `auto_merge` column (088, for the `feature` kind's `feature_runs.auto_merge`) — the aggregate shares
-- one column across kinds — so only the `plans` sync triggers (089/120) and the `plans__units` compat
-- VIEW (091/120) are re-created verbatim plus the column, exactly as migration 120 mirrored
-- `auto_resolve_escalations`. Only the `epic` kind's triggers/VIEW change; the others are untouched.

DROP TRIGGER IF EXISTS plans__du_ai;
CREATE TRIGGER plans__du_ai AFTER INSERT ON plans
BEGIN
  INSERT OR REPLACE INTO delivery_units (unit_id, kind, legacy_key, legacy_id, parent_unit_id, node_index, delivery_status, dispatch_status, repo, issue_number, issue_url, title, status, task_count, process_key, outcome, gate_wave, blackboard_token, retro_started_at, base_branch, epic_phase, promotion_pr, promotion_state, acknowledged_at, list_bucket, ack_open, wait_gate, wait_gate_label, bound_artifacts, auto_resolve_escalations, auto_merge, created_at, updated_at)
  VALUES ('epic:' || NEW.plan_key, 'epic', NEW.plan_key, NULL, NULL, NULL, CASE WHEN NEW.status = 'planning' THEN 'requested' WHEN NEW.status = 'dispatched' THEN 'running' WHEN NEW.status = 'done' THEN 'done' WHEN NEW.status = 'failed' THEN 'failed' WHEN NEW.status = 'abandoned' THEN 'abandoned' ELSE NULL END, CASE WHEN NEW.status IN ('planning') THEN 'pending' WHEN NEW.status IN ('done', 'failed', 'abandoned') THEN 'settled' WHEN NEW.status IN ('dispatched') THEN 'dispatched' ELSE NULL END, NEW.repo, NEW.issue_number, NEW.issue_url, NEW.title, NEW.status, NEW.task_count, NEW.process_key, NEW.outcome, NEW.gate_wave, NEW.blackboard_token, NEW.retro_started_at, NEW.base_branch, NEW.epic_phase, NEW.promotion_pr, NEW.promotion_state, NEW.acknowledged_at, NEW.list_bucket, NEW.ack_open, NEW.wait_gate, NEW.wait_gate_label, NEW.bound_artifacts, NEW.auto_resolve_escalations, NEW.auto_merge, NEW.created_at, NEW.updated_at);
END;

DROP TRIGGER IF EXISTS plans__du_au;
CREATE TRIGGER plans__du_au AFTER UPDATE ON plans
BEGIN
  INSERT OR REPLACE INTO delivery_units (unit_id, kind, legacy_key, legacy_id, parent_unit_id, node_index, delivery_status, dispatch_status, repo, issue_number, issue_url, title, status, task_count, process_key, outcome, gate_wave, blackboard_token, retro_started_at, base_branch, epic_phase, promotion_pr, promotion_state, acknowledged_at, list_bucket, ack_open, wait_gate, wait_gate_label, bound_artifacts, auto_resolve_escalations, auto_merge, created_at, updated_at)
  VALUES ('epic:' || NEW.plan_key, 'epic', NEW.plan_key, NULL, NULL, NULL, CASE WHEN NEW.status = 'planning' THEN 'requested' WHEN NEW.status = 'dispatched' THEN 'running' WHEN NEW.status = 'done' THEN 'done' WHEN NEW.status = 'failed' THEN 'failed' WHEN NEW.status = 'abandoned' THEN 'abandoned' ELSE NULL END, CASE WHEN NEW.status IN ('planning') THEN 'pending' WHEN NEW.status IN ('done', 'failed', 'abandoned') THEN 'settled' WHEN NEW.status IN ('dispatched') THEN 'dispatched' ELSE NULL END, NEW.repo, NEW.issue_number, NEW.issue_url, NEW.title, NEW.status, NEW.task_count, NEW.process_key, NEW.outcome, NEW.gate_wave, NEW.blackboard_token, NEW.retro_started_at, NEW.base_branch, NEW.epic_phase, NEW.promotion_pr, NEW.promotion_state, NEW.acknowledged_at, NEW.list_bucket, NEW.ack_open, NEW.wait_gate, NEW.wait_gate_label, NEW.bound_artifacts, NEW.auto_resolve_escalations, NEW.auto_merge, NEW.created_at, NEW.updated_at);
END;

DROP VIEW IF EXISTS plans__units;
CREATE VIEW plans__units AS
SELECT
  du.legacy_key AS plan_key,
  du.repo AS repo,
  du.issue_number AS issue_number,
  du.issue_url AS issue_url,
  du.title AS title,
  du.status AS status,
  du.task_count AS task_count,
  du.process_key AS process_key,
  du.outcome AS outcome,
  du.created_at AS created_at,
  du.updated_at AS updated_at,
  du.gate_wave AS gate_wave,
  du.blackboard_token AS blackboard_token,
  du.retro_started_at AS retro_started_at,
  du.base_branch AS base_branch,
  du.epic_phase AS epic_phase,
  du.promotion_pr AS promotion_pr,
  du.promotion_state AS promotion_state,
  du.acknowledged_at AS acknowledged_at,
  du.list_bucket AS list_bucket,
  du.ack_open AS ack_open,
  du.wait_gate AS wait_gate,
  du.wait_gate_label AS wait_gate_label,
  du.bound_artifacts AS bound_artifacts,
  du.auto_resolve_escalations AS auto_resolve_escalations,
  du.auto_merge AS auto_merge
FROM delivery_units du
WHERE du.kind = 'epic';
