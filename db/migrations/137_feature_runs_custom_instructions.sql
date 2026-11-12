-- Durable operator-steering TEXT on the feature run (issue #956 review, Copilot thread
-- 4547353302). `startFeature` already seeds `customInstructions` onto the feature INSTANCE's
-- variables, and the `pr.converge-feature` worker forwards it to `submitPr` — but the worker
-- publishes `converging` BEFORE enrolling, so `pollFeatureDelivery`'s re-enroll edge can win the
-- race (or recover an interrupted handoff) and call `submitPr` with NO job variables, starting a
-- loop without the instructions; the worker's later call then returns `alreadyRunning` without
-- updating the live loop. Persist the trimmed text on the run row BEFORE the instance/handoff
-- exists so the poller's enrollment path (and the worker) read the SAME durable source. The text
-- is the operator's own input (already written to the instance and prompts), so a TEXT column
-- carries no new sensitivity class. NULL when the run carries no steering.
--
-- The column is mirrored through the `delivery_units` aggregate so the `feature_runs__units` compat
-- VIEW stays row-for-row equal to `feature_runs` (ADR 0006, parity-tested in
-- app/deliveryUnit.test.ts): the Feature sync triggers (089) and VIEW (091) are re-created verbatim
-- plus `custom_instructions`, exactly as migration 125 did for the pr-link columns.

ALTER TABLE feature_runs ADD COLUMN custom_instructions TEXT;

ALTER TABLE delivery_units ADD COLUMN custom_instructions TEXT;

DROP TRIGGER IF EXISTS feature_runs__du_ai;
CREATE TRIGGER feature_runs__du_ai AFTER INSERT ON feature_runs
BEGIN
  INSERT OR REPLACE INTO delivery_units (unit_id, kind, legacy_key, legacy_id, parent_unit_id, node_index, delivery_status, dispatch_status, repo, issue_number, issue_url, title, base_branch, status, process_key, pr_key, converge, auto_merge, human_approval, auto_resolve_escalations, custom_instructions, outcome, delivery_label, pr_linked_pr_key, pr_link_want_pr_key, pr_link_lease_at, acknowledged_at, stage, stage_state, stage_skipped, attention, list_bucket, created_at, updated_at)
  VALUES ('feature:' || NEW.feature_key, 'feature', NEW.feature_key, NULL, NULL, NULL, CASE WHEN NEW.status = 'running' THEN 'running' WHEN NEW.status = 'escalated' THEN 'escalated' WHEN NEW.status = 'opened' THEN 'opened' WHEN NEW.status = 'converging' THEN 'converging' WHEN NEW.status = 'awaiting_operator' THEN 'awaiting_operator' WHEN NEW.status = 'merged' THEN 'merged' WHEN NEW.status = 'converged' THEN 'converged' WHEN NEW.status = 'blocked' THEN 'blocked' WHEN NEW.status = 'skipped' THEN 'skipped' WHEN NEW.status = 'failed' THEN 'failed' WHEN NEW.status = 'abandoned' THEN 'abandoned' ELSE NULL END, CASE WHEN NEW.status IN ('opened', 'converging', 'merged', 'converged', 'blocked', 'skipped', 'failed', 'abandoned') THEN 'settled' WHEN NEW.status IN ('running', 'escalated', 'awaiting_operator') THEN 'dispatched' ELSE NULL END, NEW.repo, NEW.issue_number, NEW.issue_url, NEW.title, NEW.base_branch, NEW.status, NEW.process_key, NEW.pr_key, NEW.converge, NEW.auto_merge, NEW.human_approval, NEW.auto_resolve_escalations, NEW.custom_instructions, NEW.outcome, NEW.delivery_label, NEW.pr_linked_pr_key, NEW.pr_link_want_pr_key, NEW.pr_link_lease_at, NEW.acknowledged_at, NEW.stage, NEW.stage_state, NEW.stage_skipped, NEW.attention, NEW.list_bucket, NEW.created_at, NEW.updated_at);
END;

DROP TRIGGER IF EXISTS feature_runs__du_au;
CREATE TRIGGER feature_runs__du_au AFTER UPDATE ON feature_runs
BEGIN
  INSERT OR REPLACE INTO delivery_units (unit_id, kind, legacy_key, legacy_id, parent_unit_id, node_index, delivery_status, dispatch_status, repo, issue_number, issue_url, title, base_branch, status, process_key, pr_key, converge, auto_merge, human_approval, auto_resolve_escalations, custom_instructions, outcome, delivery_label, pr_linked_pr_key, pr_link_want_pr_key, pr_link_lease_at, acknowledged_at, stage, stage_state, stage_skipped, attention, list_bucket, created_at, updated_at)
  VALUES ('feature:' || NEW.feature_key, 'feature', NEW.feature_key, NULL, NULL, NULL, CASE WHEN NEW.status = 'running' THEN 'running' WHEN NEW.status = 'escalated' THEN 'escalated' WHEN NEW.status = 'opened' THEN 'opened' WHEN NEW.status = 'converging' THEN 'converging' WHEN NEW.status = 'awaiting_operator' THEN 'awaiting_operator' WHEN NEW.status = 'merged' THEN 'merged' WHEN NEW.status = 'converged' THEN 'converged' WHEN NEW.status = 'blocked' THEN 'blocked' WHEN NEW.status = 'skipped' THEN 'skipped' WHEN NEW.status = 'failed' THEN 'failed' WHEN NEW.status = 'abandoned' THEN 'abandoned' ELSE NULL END, CASE WHEN NEW.status IN ('opened', 'converging', 'merged', 'converged', 'blocked', 'skipped', 'failed', 'abandoned') THEN 'settled' WHEN NEW.status IN ('running', 'escalated', 'awaiting_operator') THEN 'dispatched' ELSE NULL END, NEW.repo, NEW.issue_number, NEW.issue_url, NEW.title, NEW.base_branch, NEW.status, NEW.process_key, NEW.pr_key, NEW.converge, NEW.auto_merge, NEW.human_approval, NEW.auto_resolve_escalations, NEW.custom_instructions, NEW.outcome, NEW.delivery_label, NEW.pr_linked_pr_key, NEW.pr_link_want_pr_key, NEW.pr_link_lease_at, NEW.acknowledged_at, NEW.stage, NEW.stage_state, NEW.stage_skipped, NEW.attention, NEW.list_bucket, NEW.created_at, NEW.updated_at);
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
  du.auto_resolve_escalations AS auto_resolve_escalations,
  du.custom_instructions AS custom_instructions,
  du.outcome AS outcome,
  du.created_at AS created_at,
  du.updated_at AS updated_at,
  du.delivery_label AS delivery_label,
  du.pr_linked_pr_key AS pr_linked_pr_key,
  du.pr_link_want_pr_key AS pr_link_want_pr_key,
  du.pr_link_lease_at AS pr_link_lease_at,
  du.title AS title,
  du.acknowledged_at AS acknowledged_at,
  du.stage AS stage,
  du.stage_state AS stage_state,
  du.stage_skipped AS stage_skipped,
  du.attention AS attention,
  du.list_bucket AS list_bucket
FROM delivery_units du
WHERE du.kind = 'feature';
