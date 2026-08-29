-- ADR 0006 slice S2 (#589) — DB-level sync triggers mirroring every legacy delivery-unit write into
-- the `delivery_units` aggregate (088). AFTER INSERT/UPDATE/DELETE on each of the four legacy tables
-- keeps the aggregate in perfect lockstep regardless of WHICH writer touched the base row — the app
-- gateways (app/feature.ts, app/plan.ts, app/deliveryGraphRun.ts), the plan/wave/results workers, the
-- service pollers, AND the raw-SQL compare-and-swap in `claimRunForLaunch` (app/deliveryGraphRun.ts)
-- that bypasses the gateway. A trigger fires at the DB level, so there is no drift surface and no
-- write-path code to keep in sync (derivation over duplication). ADR 0065 makes `instanceTracking` a
-- SOURCE that no longer writes base rows, so the base `status` these triggers read is always the
-- worker-owned transient — the terminal fold stays derived on the legacy `__tracking` VIEWs.
--
-- `INSERT OR REPLACE` on the derived `unit_id` makes each trigger idempotent (an update re-projects
-- the whole row). `delivery_status` (canonical S1 union) and `dispatch_status` are computed by the
-- same CASE lowerings app/deliveryUnit.ts mirrors in TS, guarded at parity by app/deliveryUnit.test.ts.
-- The runner wraps each file in its own transaction — no BEGIN/COMMIT here.

DROP TRIGGER IF EXISTS feature_runs__du_ai;
CREATE TRIGGER feature_runs__du_ai AFTER INSERT ON feature_runs
BEGIN
  INSERT OR REPLACE INTO delivery_units (unit_id, kind, legacy_key, legacy_id, parent_unit_id, node_index, delivery_status, dispatch_status, repo, issue_number, issue_url, title, base_branch, status, process_key, pr_key, converge, auto_merge, outcome, delivery_label, acknowledged_at, stage, stage_state, stage_skipped, attention, list_bucket, created_at, updated_at)
  VALUES ('feature:' || NEW.feature_key, 'feature', NEW.feature_key, NULL, NULL, NULL, CASE WHEN NEW.status = 'running' THEN 'running' WHEN NEW.status = 'escalated' THEN 'escalated' WHEN NEW.status = 'opened' THEN 'opened' WHEN NEW.status = 'converging' THEN 'converging' WHEN NEW.status = 'awaiting_operator' THEN 'awaiting_operator' WHEN NEW.status = 'merged' THEN 'merged' WHEN NEW.status = 'converged' THEN 'converged' WHEN NEW.status = 'blocked' THEN 'blocked' WHEN NEW.status = 'skipped' THEN 'skipped' WHEN NEW.status = 'failed' THEN 'failed' WHEN NEW.status = 'abandoned' THEN 'abandoned' ELSE NULL END, CASE WHEN NEW.status IN ('opened', 'converging', 'merged', 'converged', 'blocked', 'skipped', 'failed', 'abandoned') THEN 'settled' WHEN NEW.status IN ('running', 'escalated', 'awaiting_operator') THEN 'dispatched' ELSE NULL END, NEW.repo, NEW.issue_number, NEW.issue_url, NEW.title, NEW.base_branch, NEW.status, NEW.process_key, NEW.pr_key, NEW.converge, NEW.auto_merge, NEW.outcome, NEW.delivery_label, NEW.acknowledged_at, NEW.stage, NEW.stage_state, NEW.stage_skipped, NEW.attention, NEW.list_bucket, NEW.created_at, NEW.updated_at);
END;

DROP TRIGGER IF EXISTS feature_runs__du_au;
CREATE TRIGGER feature_runs__du_au AFTER UPDATE ON feature_runs
BEGIN
  INSERT OR REPLACE INTO delivery_units (unit_id, kind, legacy_key, legacy_id, parent_unit_id, node_index, delivery_status, dispatch_status, repo, issue_number, issue_url, title, base_branch, status, process_key, pr_key, converge, auto_merge, outcome, delivery_label, acknowledged_at, stage, stage_state, stage_skipped, attention, list_bucket, created_at, updated_at)
  VALUES ('feature:' || NEW.feature_key, 'feature', NEW.feature_key, NULL, NULL, NULL, CASE WHEN NEW.status = 'running' THEN 'running' WHEN NEW.status = 'escalated' THEN 'escalated' WHEN NEW.status = 'opened' THEN 'opened' WHEN NEW.status = 'converging' THEN 'converging' WHEN NEW.status = 'awaiting_operator' THEN 'awaiting_operator' WHEN NEW.status = 'merged' THEN 'merged' WHEN NEW.status = 'converged' THEN 'converged' WHEN NEW.status = 'blocked' THEN 'blocked' WHEN NEW.status = 'skipped' THEN 'skipped' WHEN NEW.status = 'failed' THEN 'failed' WHEN NEW.status = 'abandoned' THEN 'abandoned' ELSE NULL END, CASE WHEN NEW.status IN ('opened', 'converging', 'merged', 'converged', 'blocked', 'skipped', 'failed', 'abandoned') THEN 'settled' WHEN NEW.status IN ('running', 'escalated', 'awaiting_operator') THEN 'dispatched' ELSE NULL END, NEW.repo, NEW.issue_number, NEW.issue_url, NEW.title, NEW.base_branch, NEW.status, NEW.process_key, NEW.pr_key, NEW.converge, NEW.auto_merge, NEW.outcome, NEW.delivery_label, NEW.acknowledged_at, NEW.stage, NEW.stage_state, NEW.stage_skipped, NEW.attention, NEW.list_bucket, NEW.created_at, NEW.updated_at);
END;

DROP TRIGGER IF EXISTS feature_runs__du_ad;
CREATE TRIGGER feature_runs__du_ad AFTER DELETE ON feature_runs
BEGIN
  DELETE FROM delivery_units WHERE unit_id = 'feature:' || OLD.feature_key;
END;

DROP TRIGGER IF EXISTS plans__du_ai;
CREATE TRIGGER plans__du_ai AFTER INSERT ON plans
BEGIN
  INSERT OR REPLACE INTO delivery_units (unit_id, kind, legacy_key, legacy_id, parent_unit_id, node_index, delivery_status, dispatch_status, repo, issue_number, issue_url, title, status, task_count, process_key, outcome, gate_wave, blackboard_token, retro_started_at, base_branch, epic_phase, promotion_pr, promotion_state, acknowledged_at, list_bucket, ack_open, wait_gate, wait_gate_label, bound_artifacts, created_at, updated_at)
  VALUES ('epic:' || NEW.plan_key, 'epic', NEW.plan_key, NULL, NULL, NULL, CASE WHEN NEW.status = 'planning' THEN 'requested' WHEN NEW.status = 'dispatched' THEN 'running' WHEN NEW.status = 'done' THEN 'done' WHEN NEW.status = 'failed' THEN 'failed' WHEN NEW.status = 'abandoned' THEN 'abandoned' ELSE NULL END, CASE WHEN NEW.status IN ('planning') THEN 'pending' WHEN NEW.status IN ('done', 'failed', 'abandoned') THEN 'settled' WHEN NEW.status IN ('dispatched') THEN 'dispatched' ELSE NULL END, NEW.repo, NEW.issue_number, NEW.issue_url, NEW.title, NEW.status, NEW.task_count, NEW.process_key, NEW.outcome, NEW.gate_wave, NEW.blackboard_token, NEW.retro_started_at, NEW.base_branch, NEW.epic_phase, NEW.promotion_pr, NEW.promotion_state, NEW.acknowledged_at, NEW.list_bucket, NEW.ack_open, NEW.wait_gate, NEW.wait_gate_label, NEW.bound_artifacts, NEW.created_at, NEW.updated_at);
END;

DROP TRIGGER IF EXISTS plans__du_au;
CREATE TRIGGER plans__du_au AFTER UPDATE ON plans
BEGIN
  INSERT OR REPLACE INTO delivery_units (unit_id, kind, legacy_key, legacy_id, parent_unit_id, node_index, delivery_status, dispatch_status, repo, issue_number, issue_url, title, status, task_count, process_key, outcome, gate_wave, blackboard_token, retro_started_at, base_branch, epic_phase, promotion_pr, promotion_state, acknowledged_at, list_bucket, ack_open, wait_gate, wait_gate_label, bound_artifacts, created_at, updated_at)
  VALUES ('epic:' || NEW.plan_key, 'epic', NEW.plan_key, NULL, NULL, NULL, CASE WHEN NEW.status = 'planning' THEN 'requested' WHEN NEW.status = 'dispatched' THEN 'running' WHEN NEW.status = 'done' THEN 'done' WHEN NEW.status = 'failed' THEN 'failed' WHEN NEW.status = 'abandoned' THEN 'abandoned' ELSE NULL END, CASE WHEN NEW.status IN ('planning') THEN 'pending' WHEN NEW.status IN ('done', 'failed', 'abandoned') THEN 'settled' WHEN NEW.status IN ('dispatched') THEN 'dispatched' ELSE NULL END, NEW.repo, NEW.issue_number, NEW.issue_url, NEW.title, NEW.status, NEW.task_count, NEW.process_key, NEW.outcome, NEW.gate_wave, NEW.blackboard_token, NEW.retro_started_at, NEW.base_branch, NEW.epic_phase, NEW.promotion_pr, NEW.promotion_state, NEW.acknowledged_at, NEW.list_bucket, NEW.ack_open, NEW.wait_gate, NEW.wait_gate_label, NEW.bound_artifacts, NEW.created_at, NEW.updated_at);
END;

DROP TRIGGER IF EXISTS plans__du_ad;
CREATE TRIGGER plans__du_ad AFTER DELETE ON plans
BEGIN
  DELETE FROM delivery_units WHERE unit_id = 'epic:' || OLD.plan_key;
END;

DROP TRIGGER IF EXISTS plan_tasks__du_ai;
CREATE TRIGGER plan_tasks__du_ai AFTER INSERT ON plan_tasks
BEGIN
  INSERT OR REPLACE INTO delivery_units (unit_id, kind, legacy_key, legacy_id, parent_unit_id, node_index, delivery_status, dispatch_status, title, prompt, status, pr_key, summary, wave, open_question, answer, draft_pr_key, corr_key, created_at, updated_at, task_id)
  VALUES ('plan-task:' || NEW.plan_key || '#' || NEW.task_index, 'plan-task', NEW.plan_key, NEW.id, 'epic:' || NEW.plan_key, NEW.task_index, CASE WHEN NEW.status = 'pending' THEN 'requested' WHEN NEW.status = 'opened' THEN 'opened' WHEN NEW.status = 'blocked' THEN 'blocked' WHEN NEW.status = 'skipped' THEN 'skipped' WHEN NEW.status = 'escalated' THEN 'escalated' WHEN NEW.status = 'waiting-for-lane' THEN 'waiting' WHEN NEW.status = 'abandoned' THEN 'abandoned' ELSE NULL END, CASE WHEN NEW.status IN ('pending') THEN 'pending' WHEN NEW.status IN ('opened', 'blocked', 'skipped', 'abandoned') THEN 'settled' WHEN NEW.status IN ('escalated', 'waiting-for-lane') THEN 'dispatched' ELSE NULL END, NEW.title, NEW.prompt, NEW.status, NEW.pr_key, NEW.summary, NEW.wave, NEW.open_question, NEW.answer, NEW.draft_pr_key, NEW.corr_key, NEW.created_at, NEW.updated_at, NEW.task_id);
END;

DROP TRIGGER IF EXISTS plan_tasks__du_au;
CREATE TRIGGER plan_tasks__du_au AFTER UPDATE ON plan_tasks
BEGIN
  INSERT OR REPLACE INTO delivery_units (unit_id, kind, legacy_key, legacy_id, parent_unit_id, node_index, delivery_status, dispatch_status, title, prompt, status, pr_key, summary, wave, open_question, answer, draft_pr_key, corr_key, created_at, updated_at, task_id)
  VALUES ('plan-task:' || NEW.plan_key || '#' || NEW.task_index, 'plan-task', NEW.plan_key, NEW.id, 'epic:' || NEW.plan_key, NEW.task_index, CASE WHEN NEW.status = 'pending' THEN 'requested' WHEN NEW.status = 'opened' THEN 'opened' WHEN NEW.status = 'blocked' THEN 'blocked' WHEN NEW.status = 'skipped' THEN 'skipped' WHEN NEW.status = 'escalated' THEN 'escalated' WHEN NEW.status = 'waiting-for-lane' THEN 'waiting' WHEN NEW.status = 'abandoned' THEN 'abandoned' ELSE NULL END, CASE WHEN NEW.status IN ('pending') THEN 'pending' WHEN NEW.status IN ('opened', 'blocked', 'skipped', 'abandoned') THEN 'settled' WHEN NEW.status IN ('escalated', 'waiting-for-lane') THEN 'dispatched' ELSE NULL END, NEW.title, NEW.prompt, NEW.status, NEW.pr_key, NEW.summary, NEW.wave, NEW.open_question, NEW.answer, NEW.draft_pr_key, NEW.corr_key, NEW.created_at, NEW.updated_at, NEW.task_id);
END;

DROP TRIGGER IF EXISTS plan_tasks__du_ad;
CREATE TRIGGER plan_tasks__du_ad AFTER DELETE ON plan_tasks
BEGIN
  DELETE FROM delivery_units WHERE unit_id = 'plan-task:' || OLD.plan_key || '#' || OLD.task_index;
END;

DROP TRIGGER IF EXISTS delivery_graph_runs__du_ai;
CREATE TRIGGER delivery_graph_runs__du_ai AFTER INSERT ON delivery_graph_runs
BEGIN
  INSERT OR REPLACE INTO delivery_units (unit_id, kind, legacy_key, legacy_id, parent_unit_id, node_index, delivery_status, dispatch_status, process_key, process_definition_id, digest, status, side_effecting, node_count, human_node_count, side_effect_count, title, phase, phase_node_id, human_labels, created_at, updated_at)
  VALUES ('delivery-graph:' || NEW.run_key, 'delivery-graph', NEW.run_key, NULL, NULL, NULL, CASE WHEN NEW.status = 'awaiting-approval' THEN 'requested' WHEN NEW.status = 'running' THEN 'running' WHEN NEW.status = 'done' THEN 'done' WHEN NEW.status = 'failed' THEN 'failed' WHEN NEW.status = 'abandoned' THEN 'abandoned' ELSE NULL END, CASE WHEN NEW.status IN ('awaiting-approval') THEN 'pending' WHEN NEW.status IN ('done', 'failed', 'abandoned') THEN 'settled' WHEN NEW.status IN ('running') THEN 'dispatched' ELSE NULL END, NEW.process_key, NEW.process_definition_id, NEW.digest, NEW.status, NEW.side_effecting, NEW.node_count, NEW.human_node_count, NEW.side_effect_count, NEW.title, NEW.phase, NEW.phase_node_id, NEW.human_labels, NEW.created_at, NEW.updated_at);
END;

DROP TRIGGER IF EXISTS delivery_graph_runs__du_au;
CREATE TRIGGER delivery_graph_runs__du_au AFTER UPDATE ON delivery_graph_runs
BEGIN
  INSERT OR REPLACE INTO delivery_units (unit_id, kind, legacy_key, legacy_id, parent_unit_id, node_index, delivery_status, dispatch_status, process_key, process_definition_id, digest, status, side_effecting, node_count, human_node_count, side_effect_count, title, phase, phase_node_id, human_labels, created_at, updated_at)
  VALUES ('delivery-graph:' || NEW.run_key, 'delivery-graph', NEW.run_key, NULL, NULL, NULL, CASE WHEN NEW.status = 'awaiting-approval' THEN 'requested' WHEN NEW.status = 'running' THEN 'running' WHEN NEW.status = 'done' THEN 'done' WHEN NEW.status = 'failed' THEN 'failed' WHEN NEW.status = 'abandoned' THEN 'abandoned' ELSE NULL END, CASE WHEN NEW.status IN ('awaiting-approval') THEN 'pending' WHEN NEW.status IN ('done', 'failed', 'abandoned') THEN 'settled' WHEN NEW.status IN ('running') THEN 'dispatched' ELSE NULL END, NEW.process_key, NEW.process_definition_id, NEW.digest, NEW.status, NEW.side_effecting, NEW.node_count, NEW.human_node_count, NEW.side_effect_count, NEW.title, NEW.phase, NEW.phase_node_id, NEW.human_labels, NEW.created_at, NEW.updated_at);
END;

DROP TRIGGER IF EXISTS delivery_graph_runs__du_ad;
CREATE TRIGGER delivery_graph_runs__du_ad AFTER DELETE ON delivery_graph_runs
BEGIN
  DELETE FROM delivery_units WHERE unit_id = 'delivery-graph:' || OLD.run_key;
END;
