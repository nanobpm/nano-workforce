-- Issue #826: optional human approval before merge. 1 ⇒ the converged PR parks at the
-- `merge-approval` user task in convergence-loop.bpmn before the merge-loop runs. Additive (expand).
ALTER TABLE feature_runs ADD COLUMN human_approval INTEGER NOT NULL DEFAULT 0;

-- Mirror the new column through the `delivery_units` aggregate so the `feature_runs__units` compat VIEW
-- stays row-for-row equal to `feature_runs` (ADR 0006, parity-tested in app/deliveryUnit.test.ts): the
-- Feature sync triggers (089) and VIEW (091) are re-created verbatim plus `human_approval`.
ALTER TABLE delivery_units ADD COLUMN human_approval INTEGER;
UPDATE delivery_units SET human_approval = 0 WHERE kind = 'feature';

DROP TRIGGER IF EXISTS feature_runs__du_ai;
CREATE TRIGGER feature_runs__du_ai AFTER INSERT ON feature_runs
BEGIN
  INSERT OR REPLACE INTO delivery_units (unit_id, kind, legacy_key, legacy_id, parent_unit_id, node_index, delivery_status, dispatch_status, repo, issue_number, issue_url, title, base_branch, status, process_key, pr_key, converge, auto_merge, human_approval, outcome, delivery_label, acknowledged_at, stage, stage_state, stage_skipped, attention, list_bucket, created_at, updated_at)
  VALUES ('feature:' || NEW.feature_key, 'feature', NEW.feature_key, NULL, NULL, NULL, CASE WHEN NEW.status = 'running' THEN 'running' WHEN NEW.status = 'escalated' THEN 'escalated' WHEN NEW.status = 'opened' THEN 'opened' WHEN NEW.status = 'converging' THEN 'converging' WHEN NEW.status = 'awaiting_operator' THEN 'awaiting_operator' WHEN NEW.status = 'merged' THEN 'merged' WHEN NEW.status = 'converged' THEN 'converged' WHEN NEW.status = 'blocked' THEN 'blocked' WHEN NEW.status = 'skipped' THEN 'skipped' WHEN NEW.status = 'failed' THEN 'failed' WHEN NEW.status = 'abandoned' THEN 'abandoned' ELSE NULL END, CASE WHEN NEW.status IN ('opened', 'converging', 'merged', 'converged', 'blocked', 'skipped', 'failed', 'abandoned') THEN 'settled' WHEN NEW.status IN ('running', 'escalated', 'awaiting_operator') THEN 'dispatched' ELSE NULL END, NEW.repo, NEW.issue_number, NEW.issue_url, NEW.title, NEW.base_branch, NEW.status, NEW.process_key, NEW.pr_key, NEW.converge, NEW.auto_merge, NEW.human_approval, NEW.outcome, NEW.delivery_label, NEW.acknowledged_at, NEW.stage, NEW.stage_state, NEW.stage_skipped, NEW.attention, NEW.list_bucket, NEW.created_at, NEW.updated_at);
END;

DROP TRIGGER IF EXISTS feature_runs__du_au;
CREATE TRIGGER feature_runs__du_au AFTER UPDATE ON feature_runs
BEGIN
  INSERT OR REPLACE INTO delivery_units (unit_id, kind, legacy_key, legacy_id, parent_unit_id, node_index, delivery_status, dispatch_status, repo, issue_number, issue_url, title, base_branch, status, process_key, pr_key, converge, auto_merge, human_approval, outcome, delivery_label, acknowledged_at, stage, stage_state, stage_skipped, attention, list_bucket, created_at, updated_at)
  VALUES ('feature:' || NEW.feature_key, 'feature', NEW.feature_key, NULL, NULL, NULL, CASE WHEN NEW.status = 'running' THEN 'running' WHEN NEW.status = 'escalated' THEN 'escalated' WHEN NEW.status = 'opened' THEN 'opened' WHEN NEW.status = 'converging' THEN 'converging' WHEN NEW.status = 'awaiting_operator' THEN 'awaiting_operator' WHEN NEW.status = 'merged' THEN 'merged' WHEN NEW.status = 'converged' THEN 'converged' WHEN NEW.status = 'blocked' THEN 'blocked' WHEN NEW.status = 'skipped' THEN 'skipped' WHEN NEW.status = 'failed' THEN 'failed' WHEN NEW.status = 'abandoned' THEN 'abandoned' ELSE NULL END, CASE WHEN NEW.status IN ('opened', 'converging', 'merged', 'converged', 'blocked', 'skipped', 'failed', 'abandoned') THEN 'settled' WHEN NEW.status IN ('running', 'escalated', 'awaiting_operator') THEN 'dispatched' ELSE NULL END, NEW.repo, NEW.issue_number, NEW.issue_url, NEW.title, NEW.base_branch, NEW.status, NEW.process_key, NEW.pr_key, NEW.converge, NEW.auto_merge, NEW.human_approval, NEW.outcome, NEW.delivery_label, NEW.acknowledged_at, NEW.stage, NEW.stage_state, NEW.stage_skipped, NEW.attention, NEW.list_bucket, NEW.created_at, NEW.updated_at);
END;

DROP VIEW IF EXISTS feature_runs__units;
CREATE VIEW feature_runs__units AS
SELECT
  du.legacy_key AS feature_key,
  du.repo AS repo,
  du.issue_number AS issue_number,
  du.issue_url AS issue_url,
  du.base_branch AS base_branch,
  du.status AS status,
  du.process_key AS process_key,
  du.pr_key AS pr_key,
  du.converge AS converge,
  du.auto_merge AS auto_merge,
  du.human_approval AS human_approval,
  du.outcome AS outcome,
  du.created_at AS created_at,
  du.updated_at AS updated_at,
  du.delivery_label AS delivery_label,
  du.title AS title,
  du.acknowledged_at AS acknowledged_at,
  du.stage AS stage,
  du.stage_state AS stage_state,
  du.stage_skipped AS stage_skipped,
  du.attention AS attention,
  du.list_bucket AS list_bucket
FROM delivery_units du
WHERE du.kind = 'feature';
