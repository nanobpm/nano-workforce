-- ADR 0006 slice S2 (#589) — legacy-shaped compatibility VIEWs served FROM the `delivery_units`
-- aggregate (088). Each VIEW reconstructs one legacy table's exact column set from the kind-tagged
-- aggregate row, so a read path can swap onto the aggregate with byte-identical results — the
-- "legacy tables become VIEWs/rows over the aggregate" surface of ADR 0006 §2, guarded by the parity
-- tests in app/deliveryUnit.test.ts (each VIEW is proven row-for-row equal to its base table over the
-- full status/shape matrix). These are ADDITIVE read surfaces; the live pages/read-models keep binding
-- the physical base tables until S3 moves the writers, so no behaviour changes here.
--
-- A single plain `CREATE VIEW … SELECT … FROM delivery_units` per shape (one top-level FROM, every
-- column aliased) so the static pages<->schema contract guard can parse the column list. The runner
-- wraps each file in its own transaction — no BEGIN/COMMIT here.

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
  du.bound_artifacts AS bound_artifacts
FROM delivery_units du
WHERE du.kind = 'epic';

DROP VIEW IF EXISTS plan_tasks__units;
CREATE VIEW plan_tasks__units AS
SELECT
  du.legacy_id AS id,
  du.legacy_key AS plan_key,
  du.node_index AS task_index,
  du.task_id AS task_id,
  du.title AS title,
  du.prompt AS prompt,
  du.status AS status,
  du.pr_key AS pr_key,
  du.summary AS summary,
  du.created_at AS created_at,
  du.updated_at AS updated_at,
  du.wave AS wave,
  du.open_question AS open_question,
  du.answer AS answer,
  du.draft_pr_key AS draft_pr_key,
  du.corr_key AS corr_key
FROM delivery_units du
WHERE du.kind = 'plan-task';

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
  du.updated_at AS updated_at
FROM delivery_units du
WHERE du.kind = 'delivery-graph';
