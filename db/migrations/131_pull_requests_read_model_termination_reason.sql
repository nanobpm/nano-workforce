-- Re-create the `pull_requests_read_model` VIEW so it re-exports the new base column (the VIEW must pass
-- through EVERY base `pull_requests` column — app/pullRequestReadModel.test.ts DRIFT GUARD). A mechanical
-- re-emission of 128 with `termination_reason` added; the derived columns are emitted VERBATIM from
-- app/pullRequestReadModel.ts and are unchanged. No BEGIN/COMMIT (the runner wraps each file). Numbered after 130.

DROP VIEW IF EXISTS pull_requests_read_model;

CREATE VIEW pull_requests_read_model AS
SELECT
  pr.pr_key AS pr_key,
  pr.repo AS repo,
  pr.number AS number,
  pr.url AS url,
  pr.title AS title,
  COALESCE(pr.derived_status, pr.status) AS status,
  pr.current_round AS current_round,
  pr.process_key AS process_key,
  pr.waiting_since AS waiting_since,
  pr.last_review_id AS last_review_id,
  pr.outcome AS outcome,
  pr.created_at AS created_at,
  pr.updated_at AS updated_at,
  pr.converged_at AS converged_at,
  pr.merged_at AS merged_at,
  pr.active_worker AS active_worker,
  pr.lease_until AS lease_until,
  pr.last_nudge_at AS last_nudge_at,
  pr.fresh_head_run_head AS fresh_head_run_head,
  pr.abandon_token AS abandon_token,
  pr.incident_key AS incident_key,
  pr.incident_type AS incident_type,
  pr.incident_since AS incident_since,
  pr.incident_message AS incident_message,
  pr.last_round_head AS last_round_head,
  pr.last_progress_job_key AS last_progress_job_key,
  pr.last_progress_result AS last_progress_result,
  pr.last_progress_agent_watermark AS last_progress_agent_watermark,
  pr.churn_escalated_round AS churn_escalated_round,
  pr.root_request_key AS root_request_key,
  pr.epic_phase_label AS epic_phase_label,
  pr.acknowledged_at AS acknowledged_at,
  pr.auto_resolve_escalations AS auto_resolve_escalations,
  pr.termination_reason AS termination_reason,
  CASE WHEN COALESCE((COALESCE((COALESCE(("pr"."derived_status" = 'merged'), 0) OR COALESCE(("pr"."derived_status" = 'converged'), 0) OR COALESCE(("pr"."derived_status" = 'abandoned'), 0) OR COALESCE(("pr"."derived_status" = 'closed'), 0) OR COALESCE(("pr"."derived_status" = 'failed'), 0)), 0) AND COALESCE(("pr"."acknowledged_at" = "pr"."acknowledged_at"), 0)), 0) THEN 'history' ELSE 'active' END AS list_bucket,
  CASE WHEN COALESCE((COALESCE((COALESCE(("pr"."derived_status" = 'merged'), 0) OR COALESCE(("pr"."derived_status" = 'converged'), 0) OR COALESCE(("pr"."derived_status" = 'abandoned'), 0) OR COALESCE(("pr"."derived_status" = 'closed'), 0) OR COALESCE(("pr"."derived_status" = 'failed'), 0)), 0) AND (NOT COALESCE(COALESCE(("pr"."acknowledged_at" = "pr"."acknowledged_at"), 0), 0))), 0) THEN 1 ELSE 0 END AS ack_open
FROM pull_requests__tracking pr;
