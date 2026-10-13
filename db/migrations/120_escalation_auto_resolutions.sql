-- Issue #889: opt-in escalation steward. Two halves, both additive (expand-and-contract):
--
--   1. `auto_resolve_escalations` (0|1, default 0) on each escalation-raising subject table —
--      `feature_runs`, `plans`, `pull_requests`, `delivery_graph_runs` — recording whether the work
--      OPTED IN to having its open escalations auto-resolved by the steward. The steward's
--      eligibility derivation (app/escalationSteward.ts) reads the flag off the SUBJECT row keyed by
--      the escalation's owning process instance, so an escalation from non-opted-in work is never
--      touched. Mirrored into the `delivery_units` aggregate (ADR 0006) — the sync triggers (089) and
--      compat VIEWs (091) are re-created verbatim plus the new column, exactly as migration 116 did
--      for `human_approval` (parity-tested in app/deliveryUnit.test.ts).
--
--   2. `escalation_auto_resolutions` — the durable, reviewable record of every escalation the steward
--      ACTED ON or ABSTAINED from (one row each), backing the Auto-resolutions view and the
--      dismiss/intervene doors. `review_state` starts `pending`; an operator `dismiss`/`intervene`
--      folds it to `dismissed`/`intervened` with `reviewed_by`/`reviewed_at`/`review_note`.

ALTER TABLE feature_runs ADD COLUMN auto_resolve_escalations INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plans ADD COLUMN auto_resolve_escalations INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pull_requests ADD COLUMN auto_resolve_escalations INTEGER NOT NULL DEFAULT 0;
ALTER TABLE delivery_graph_runs ADD COLUMN auto_resolve_escalations INTEGER NOT NULL DEFAULT 0;

-- Mirror the new column through the `delivery_units` aggregate so the compat VIEWs stay row-for-row
-- equal to their base tables (ADR 0006, parity-tested in app/deliveryUnit.test.ts).
ALTER TABLE delivery_units ADD COLUMN auto_resolve_escalations INTEGER;
UPDATE delivery_units SET auto_resolve_escalations = 0 WHERE auto_resolve_escalations IS NULL;

DROP TRIGGER IF EXISTS feature_runs__du_ai;
CREATE TRIGGER feature_runs__du_ai AFTER INSERT ON feature_runs
BEGIN
  INSERT OR REPLACE INTO delivery_units (unit_id, kind, legacy_key, legacy_id, parent_unit_id, node_index, delivery_status, dispatch_status, repo, issue_number, issue_url, title, base_branch, status, process_key, pr_key, converge, auto_merge, human_approval, auto_resolve_escalations, outcome, delivery_label, acknowledged_at, stage, stage_state, stage_skipped, attention, list_bucket, created_at, updated_at)
  VALUES ('feature:' || NEW.feature_key, 'feature', NEW.feature_key, NULL, NULL, NULL, CASE WHEN NEW.status = 'running' THEN 'running' WHEN NEW.status = 'escalated' THEN 'escalated' WHEN NEW.status = 'opened' THEN 'opened' WHEN NEW.status = 'converging' THEN 'converging' WHEN NEW.status = 'awaiting_operator' THEN 'awaiting_operator' WHEN NEW.status = 'merged' THEN 'merged' WHEN NEW.status = 'converged' THEN 'converged' WHEN NEW.status = 'blocked' THEN 'blocked' WHEN NEW.status = 'skipped' THEN 'skipped' WHEN NEW.status = 'failed' THEN 'failed' WHEN NEW.status = 'abandoned' THEN 'abandoned' ELSE NULL END, CASE WHEN NEW.status IN ('opened', 'converging', 'merged', 'converged', 'blocked', 'skipped', 'failed', 'abandoned') THEN 'settled' WHEN NEW.status IN ('running', 'escalated', 'awaiting_operator') THEN 'dispatched' ELSE NULL END, NEW.repo, NEW.issue_number, NEW.issue_url, NEW.title, NEW.base_branch, NEW.status, NEW.process_key, NEW.pr_key, NEW.converge, NEW.auto_merge, NEW.human_approval, NEW.auto_resolve_escalations, NEW.outcome, NEW.delivery_label, NEW.acknowledged_at, NEW.stage, NEW.stage_state, NEW.stage_skipped, NEW.attention, NEW.list_bucket, NEW.created_at, NEW.updated_at);
END;

DROP TRIGGER IF EXISTS feature_runs__du_au;
CREATE TRIGGER feature_runs__du_au AFTER UPDATE ON feature_runs
BEGIN
  INSERT OR REPLACE INTO delivery_units (unit_id, kind, legacy_key, legacy_id, parent_unit_id, node_index, delivery_status, dispatch_status, repo, issue_number, issue_url, title, base_branch, status, process_key, pr_key, converge, auto_merge, human_approval, auto_resolve_escalations, outcome, delivery_label, acknowledged_at, stage, stage_state, stage_skipped, attention, list_bucket, created_at, updated_at)
  VALUES ('feature:' || NEW.feature_key, 'feature', NEW.feature_key, NULL, NULL, NULL, CASE WHEN NEW.status = 'running' THEN 'running' WHEN NEW.status = 'escalated' THEN 'escalated' WHEN NEW.status = 'opened' THEN 'opened' WHEN NEW.status = 'converging' THEN 'converging' WHEN NEW.status = 'awaiting_operator' THEN 'awaiting_operator' WHEN NEW.status = 'merged' THEN 'merged' WHEN NEW.status = 'converged' THEN 'converged' WHEN NEW.status = 'blocked' THEN 'blocked' WHEN NEW.status = 'skipped' THEN 'skipped' WHEN NEW.status = 'failed' THEN 'failed' WHEN NEW.status = 'abandoned' THEN 'abandoned' ELSE NULL END, CASE WHEN NEW.status IN ('opened', 'converging', 'merged', 'converged', 'blocked', 'skipped', 'failed', 'abandoned') THEN 'settled' WHEN NEW.status IN ('running', 'escalated', 'awaiting_operator') THEN 'dispatched' ELSE NULL END, NEW.repo, NEW.issue_number, NEW.issue_url, NEW.title, NEW.base_branch, NEW.status, NEW.process_key, NEW.pr_key, NEW.converge, NEW.auto_merge, NEW.human_approval, NEW.auto_resolve_escalations, NEW.outcome, NEW.delivery_label, NEW.acknowledged_at, NEW.stage, NEW.stage_state, NEW.stage_skipped, NEW.attention, NEW.list_bucket, NEW.created_at, NEW.updated_at);
END;

DROP TRIGGER IF EXISTS plans__du_ai;
CREATE TRIGGER plans__du_ai AFTER INSERT ON plans
BEGIN
  INSERT OR REPLACE INTO delivery_units (unit_id, kind, legacy_key, legacy_id, parent_unit_id, node_index, delivery_status, dispatch_status, repo, issue_number, issue_url, title, status, task_count, process_key, outcome, gate_wave, blackboard_token, retro_started_at, base_branch, epic_phase, promotion_pr, promotion_state, acknowledged_at, list_bucket, ack_open, wait_gate, wait_gate_label, bound_artifacts, auto_resolve_escalations, created_at, updated_at)
  VALUES ('epic:' || NEW.plan_key, 'epic', NEW.plan_key, NULL, NULL, NULL, CASE WHEN NEW.status = 'planning' THEN 'requested' WHEN NEW.status = 'dispatched' THEN 'running' WHEN NEW.status = 'done' THEN 'done' WHEN NEW.status = 'failed' THEN 'failed' WHEN NEW.status = 'abandoned' THEN 'abandoned' ELSE NULL END, CASE WHEN NEW.status IN ('planning') THEN 'pending' WHEN NEW.status IN ('done', 'failed', 'abandoned') THEN 'settled' WHEN NEW.status IN ('dispatched') THEN 'dispatched' ELSE NULL END, NEW.repo, NEW.issue_number, NEW.issue_url, NEW.title, NEW.status, NEW.task_count, NEW.process_key, NEW.outcome, NEW.gate_wave, NEW.blackboard_token, NEW.retro_started_at, NEW.base_branch, NEW.epic_phase, NEW.promotion_pr, NEW.promotion_state, NEW.acknowledged_at, NEW.list_bucket, NEW.ack_open, NEW.wait_gate, NEW.wait_gate_label, NEW.bound_artifacts, NEW.auto_resolve_escalations, NEW.created_at, NEW.updated_at);
END;

DROP TRIGGER IF EXISTS plans__du_au;
CREATE TRIGGER plans__du_au AFTER UPDATE ON plans
BEGIN
  INSERT OR REPLACE INTO delivery_units (unit_id, kind, legacy_key, legacy_id, parent_unit_id, node_index, delivery_status, dispatch_status, repo, issue_number, issue_url, title, status, task_count, process_key, outcome, gate_wave, blackboard_token, retro_started_at, base_branch, epic_phase, promotion_pr, promotion_state, acknowledged_at, list_bucket, ack_open, wait_gate, wait_gate_label, bound_artifacts, auto_resolve_escalations, created_at, updated_at)
  VALUES ('epic:' || NEW.plan_key, 'epic', NEW.plan_key, NULL, NULL, NULL, CASE WHEN NEW.status = 'planning' THEN 'requested' WHEN NEW.status = 'dispatched' THEN 'running' WHEN NEW.status = 'done' THEN 'done' WHEN NEW.status = 'failed' THEN 'failed' WHEN NEW.status = 'abandoned' THEN 'abandoned' ELSE NULL END, CASE WHEN NEW.status IN ('planning') THEN 'pending' WHEN NEW.status IN ('done', 'failed', 'abandoned') THEN 'settled' WHEN NEW.status IN ('dispatched') THEN 'dispatched' ELSE NULL END, NEW.repo, NEW.issue_number, NEW.issue_url, NEW.title, NEW.status, NEW.task_count, NEW.process_key, NEW.outcome, NEW.gate_wave, NEW.blackboard_token, NEW.retro_started_at, NEW.base_branch, NEW.epic_phase, NEW.promotion_pr, NEW.promotion_state, NEW.acknowledged_at, NEW.list_bucket, NEW.ack_open, NEW.wait_gate, NEW.wait_gate_label, NEW.bound_artifacts, NEW.auto_resolve_escalations, NEW.created_at, NEW.updated_at);
END;

DROP TRIGGER IF EXISTS delivery_graph_runs__du_ai;
CREATE TRIGGER delivery_graph_runs__du_ai AFTER INSERT ON delivery_graph_runs
BEGIN
  INSERT OR REPLACE INTO delivery_units (unit_id, kind, legacy_key, legacy_id, parent_unit_id, node_index, delivery_status, dispatch_status, process_key, process_definition_id, digest, status, side_effecting, node_count, human_node_count, side_effect_count, title, phase, phase_node_id, human_labels, acknowledged_at, auto_resolve_escalations, created_at, updated_at)
  VALUES ('delivery-graph:' || NEW.run_key, 'delivery-graph', NEW.run_key, NULL, NULL, NULL, CASE WHEN NEW.status = 'awaiting-approval' THEN 'requested' WHEN NEW.status = 'running' THEN 'running' WHEN NEW.status = 'done' THEN 'done' WHEN NEW.status = 'failed' THEN 'failed' WHEN NEW.status = 'abandoned' THEN 'abandoned' ELSE NULL END, CASE WHEN NEW.status IN ('awaiting-approval') THEN 'pending' WHEN NEW.status IN ('done', 'failed', 'abandoned') THEN 'settled' WHEN NEW.status IN ('running') THEN 'dispatched' ELSE NULL END, NEW.process_key, NEW.process_definition_id, NEW.digest, NEW.status, NEW.side_effecting, NEW.node_count, NEW.human_node_count, NEW.side_effect_count, NEW.title, NEW.phase, NEW.phase_node_id, NEW.human_labels, NEW.acknowledged_at, NEW.auto_resolve_escalations, NEW.created_at, NEW.updated_at);
END;

DROP TRIGGER IF EXISTS delivery_graph_runs__du_au;
CREATE TRIGGER delivery_graph_runs__du_au AFTER UPDATE ON delivery_graph_runs
BEGIN
  INSERT OR REPLACE INTO delivery_units (unit_id, kind, legacy_key, legacy_id, parent_unit_id, node_index, delivery_status, dispatch_status, process_key, process_definition_id, digest, status, side_effecting, node_count, human_node_count, side_effect_count, title, phase, phase_node_id, human_labels, acknowledged_at, auto_resolve_escalations, created_at, updated_at)
  VALUES ('delivery-graph:' || NEW.run_key, 'delivery-graph', NEW.run_key, NULL, NULL, NULL, CASE WHEN NEW.status = 'awaiting-approval' THEN 'requested' WHEN NEW.status = 'running' THEN 'running' WHEN NEW.status = 'done' THEN 'done' WHEN NEW.status = 'failed' THEN 'failed' WHEN NEW.status = 'abandoned' THEN 'abandoned' ELSE NULL END, CASE WHEN NEW.status IN ('awaiting-approval') THEN 'pending' WHEN NEW.status IN ('done', 'failed', 'abandoned') THEN 'settled' WHEN NEW.status IN ('running') THEN 'dispatched' ELSE NULL END, NEW.process_key, NEW.process_definition_id, NEW.digest, NEW.status, NEW.side_effecting, NEW.node_count, NEW.human_node_count, NEW.side_effect_count, NEW.title, NEW.phase, NEW.phase_node_id, NEW.human_labels, NEW.acknowledged_at, NEW.auto_resolve_escalations, NEW.created_at, NEW.updated_at);
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
  du.title AS title,
  du.acknowledged_at AS acknowledged_at,
  du.stage AS stage,
  du.stage_state AS stage_state,
  du.stage_skipped AS stage_skipped,
  du.attention AS attention,
  du.list_bucket AS list_bucket
FROM delivery_units du
WHERE du.kind = 'feature';

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
  du.auto_resolve_escalations AS auto_resolve_escalations
FROM delivery_units du
WHERE du.kind = 'epic';

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
  du.auto_resolve_escalations AS auto_resolve_escalations
FROM delivery_units du
WHERE du.kind = 'delivery-graph';

-- The durable, reviewable record of every escalation the steward acted on or abstained from.
CREATE TABLE escalation_auto_resolutions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The escalation user task acted on (the engine `userTaskKey`), its BPMN element id, and the
  -- escalation kind label at the time (denormalised so the record survives the task completing).
  user_task_key         TEXT NOT NULL,
  escalation_kind       TEXT,
  element_id            TEXT,
  -- The subject the escalation belongs to (PR key / feature key / plan key / delivery run key).
  subject_type          TEXT,
  subject_key           TEXT,
  subject_url           TEXT,
  process_instance_key  TEXT,
  -- Snapshots of what was asked and the choices on offer, so the record is reviewable after the fact.
  question              TEXT,
  options               TEXT,               -- JSON array of the form's option values/labels
  -- `resolved` (the steward submitted an answer) or `abstained` (it deliberately left it for a human).
  outcome               TEXT NOT NULL,      -- resolved | abstained
  submitted_variables   TEXT,               -- JSON of the variables submitted (NULL when abstained)
  rationale             TEXT,               -- one-line why
  evidence              TEXT,               -- JSON/markdown: what was checked, with links
  -- Provenance of the steward run that produced this record.
  steward_instance_key  TEXT,
  agent_job_key         TEXT,
  worker                TEXT,
  model                 TEXT,
  created_at            TEXT NOT NULL,
  -- Operator review lifecycle: pending → dismissed | intervened.
  review_state          TEXT NOT NULL DEFAULT 'pending',  -- pending | dismissed | intervened
  reviewed_by           TEXT,
  reviewed_at           TEXT,
  review_note           TEXT,
  -- Claim/lease bookkeeping (not part of the review surface): which steward instance holds the open
  -- claim and until when. NULL once the row is finalised (resolved/abstained recorded).
  claimed_by            TEXT,
  claimed_until         TEXT
);

CREATE INDEX idx_auto_resolutions_review_state ON escalation_auto_resolutions(review_state, created_at);
CREATE INDEX idx_auto_resolutions_subject ON escalation_auto_resolutions(subject_key);
-- The claim/lease fence: at most ONE open (unfinalised, `outcome='claimed'`) claim per user task, so
-- two overlapping steward ticks can never both act on the same escalation. Final rows
-- (`resolved`/`abstained`) are excluded so a re-escalation of the SAME task can be recorded afresh.
CREATE UNIQUE INDEX ux_auto_resolutions_open_claim ON escalation_auto_resolutions(user_task_key) WHERE outcome = 'claimed';
CREATE INDEX idx_auto_resolutions_task ON escalation_auto_resolutions(user_task_key);

-- The Auto-resolutions page read model (ADR 0042): projects each FINAL record (resolved/abstained —
-- never an in-flight `claimed` placeholder) with a derived `pending_review` flag (1 iff still
-- `pending`) for the row-action `showWhenField` gate, which reads JS truthiness. Derivation over
-- duplication: the grid binds this VIEW, never the base table.
CREATE VIEW escalation_auto_resolutions__read_model AS
SELECT
  id,
  user_task_key,
  escalation_kind,
  element_id,
  subject_type,
  subject_key,
  subject_url,
  process_instance_key,
  question,
  options,
  outcome,
  submitted_variables,
  rationale,
  evidence,
  steward_instance_key,
  agent_job_key,
  worker,
  model,
  created_at,
  review_state,
  reviewed_by,
  reviewed_at,
  review_note,
  CASE WHEN review_state = 'pending' THEN 1 ELSE 0 END AS pending_review
FROM escalation_auto_resolutions
WHERE outcome IN ('resolved', 'abstained');
