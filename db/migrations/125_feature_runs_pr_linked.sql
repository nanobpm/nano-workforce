-- Issue #907: the host posts one idempotent "PR opened" comment on the claimed issue when a
-- single-issue feature run delivers its PR (app/issuePrLink.ts, called by pr.record-feature).
--
-- `pr_linked_pr_key` is the DURABLE half of the link's idempotence: the `owner/repo#N` PR key the
-- "PR opened" comment was posted (or claimed) for. It is claimed with a guarded CAS UPDATE before
-- the GitHub write, so two racing passes can never both post, and a repeated pass for the same PR
-- short-circuits without touching GitHub. NULL until the run's first delivered PR is announced; a
-- failed comment POST releases it back to NULL so a later pass retries. (The other half is the
-- hidden `<!-- nwf:pr-linked:#n -->` marker scanned on the issue's comments, which heals a claim
-- lost to a crash between the POST and this record.)
--
-- Additive (expand): a nullable column with no default write — existing rows read NULL (never
-- linked), exactly the pre-#907 state (no comment was ever posted for them).
--
-- The column is mirrored through the `delivery_units` aggregate so the `feature_runs__units` compat
-- VIEW stays row-for-row equal to `feature_runs` (ADR 0006, parity-tested in
-- app/deliveryUnit.test.ts): the Feature sync triggers (089) and VIEW (091) are re-created verbatim
-- plus `pr_linked_pr_key`, exactly as migration 116 did for `human_approval` and 120 for
-- `auto_resolve_escalations`.

ALTER TABLE feature_runs ADD COLUMN pr_linked_pr_key TEXT;

ALTER TABLE delivery_units ADD COLUMN pr_linked_pr_key TEXT;

DROP TRIGGER IF EXISTS feature_runs__du_ai;
CREATE TRIGGER feature_runs__du_ai AFTER INSERT ON feature_runs
BEGIN
  INSERT OR REPLACE INTO delivery_units (unit_id, kind, legacy_key, legacy_id, parent_unit_id, node_index, delivery_status, dispatch_status, repo, issue_number, issue_url, title, base_branch, status, process_key, pr_key, converge, auto_merge, human_approval, auto_resolve_escalations, outcome, delivery_label, pr_linked_pr_key, acknowledged_at, stage, stage_state, stage_skipped, attention, list_bucket, created_at, updated_at)
  VALUES ('feature:' || NEW.feature_key, 'feature', NEW.feature_key, NULL, NULL, NULL, CASE WHEN NEW.status = 'running' THEN 'running' WHEN NEW.status = 'escalated' THEN 'escalated' WHEN NEW.status = 'opened' THEN 'opened' WHEN NEW.status = 'converging' THEN 'converging' WHEN NEW.status = 'awaiting_operator' THEN 'awaiting_operator' WHEN NEW.status = 'merged' THEN 'merged' WHEN NEW.status = 'converged' THEN 'converged' WHEN NEW.status = 'blocked' THEN 'blocked' WHEN NEW.status = 'skipped' THEN 'skipped' WHEN NEW.status = 'failed' THEN 'failed' WHEN NEW.status = 'abandoned' THEN 'abandoned' ELSE NULL END, CASE WHEN NEW.status IN ('opened', 'converging', 'merged', 'converged', 'blocked', 'skipped', 'failed', 'abandoned') THEN 'settled' WHEN NEW.status IN ('running', 'escalated', 'awaiting_operator') THEN 'dispatched' ELSE NULL END, NEW.repo, NEW.issue_number, NEW.issue_url, NEW.title, NEW.base_branch, NEW.status, NEW.process_key, NEW.pr_key, NEW.converge, NEW.auto_merge, NEW.human_approval, NEW.auto_resolve_escalations, NEW.outcome, NEW.delivery_label, NEW.pr_linked_pr_key, NEW.acknowledged_at, NEW.stage, NEW.stage_state, NEW.stage_skipped, NEW.attention, NEW.list_bucket, NEW.created_at, NEW.updated_at);
END;

DROP TRIGGER IF EXISTS feature_runs__du_au;
CREATE TRIGGER feature_runs__du_au AFTER UPDATE ON feature_runs
BEGIN
  INSERT OR REPLACE INTO delivery_units (unit_id, kind, legacy_key, legacy_id, parent_unit_id, node_index, delivery_status, dispatch_status, repo, issue_number, issue_url, title, base_branch, status, process_key, pr_key, converge, auto_merge, human_approval, auto_resolve_escalations, outcome, delivery_label, pr_linked_pr_key, acknowledged_at, stage, stage_state, stage_skipped, attention, list_bucket, created_at, updated_at)
  VALUES ('feature:' || NEW.feature_key, 'feature', NEW.feature_key, NULL, NULL, NULL, CASE WHEN NEW.status = 'running' THEN 'running' WHEN NEW.status = 'escalated' THEN 'escalated' WHEN NEW.status = 'opened' THEN 'opened' WHEN NEW.status = 'converging' THEN 'converging' WHEN NEW.status = 'awaiting_operator' THEN 'awaiting_operator' WHEN NEW.status = 'merged' THEN 'merged' WHEN NEW.status = 'converged' THEN 'converged' WHEN NEW.status = 'blocked' THEN 'blocked' WHEN NEW.status = 'skipped' THEN 'skipped' WHEN NEW.status = 'failed' THEN 'failed' WHEN NEW.status = 'abandoned' THEN 'abandoned' ELSE NULL END, CASE WHEN NEW.status IN ('opened', 'converging', 'merged', 'converged', 'blocked', 'skipped', 'failed', 'abandoned') THEN 'settled' WHEN NEW.status IN ('running', 'escalated', 'awaiting_operator') THEN 'dispatched' ELSE NULL END, NEW.repo, NEW.issue_number, NEW.issue_url, NEW.title, NEW.base_branch, NEW.status, NEW.process_key, NEW.pr_key, NEW.converge, NEW.auto_merge, NEW.human_approval, NEW.auto_resolve_escalations, NEW.outcome, NEW.delivery_label, NEW.pr_linked_pr_key, NEW.acknowledged_at, NEW.stage, NEW.stage_state, NEW.stage_skipped, NEW.attention, NEW.list_bucket, NEW.created_at, NEW.updated_at);
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
  du.outcome AS outcome,
  du.created_at AS created_at,
  du.updated_at AS updated_at,
  du.delivery_label AS delivery_label,
  du.pr_linked_pr_key AS pr_linked_pr_key,
  du.title AS title,
  du.acknowledged_at AS acknowledged_at,
  du.stage AS stage,
  du.stage_state AS stage_state,
  du.stage_skipped AS stage_skipped,
  du.attention AS attention,
  du.list_bucket AS list_bucket
FROM delivery_units du
WHERE du.kind = 'feature';
