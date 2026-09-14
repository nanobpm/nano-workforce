-- Re-create the `pull_requests_read_model` VIEW so it re-exports the two base columns added by
-- 103_pr_progress_idempotency.sql (`last_progress_job_key`, `last_progress_result`). The read-model
-- VIEW must pass through EVERY base `pull_requests` column (the static pages↔schema contract guard +
-- app/pullRequestReadModel.test.ts DRIFT GUARD assert it), so adding a base column obliges a fresh
-- VIEW definition — 094 is immutable and cannot be edited in place.
--
-- Every DERIVED column below is emitted VERBATIM from the ONE declaration in
-- app/pullRequestReadModel.ts (`pullRequestReadModel.sqlSelectFor(col, { baseAlias: "pr" })`) — the
-- same closed-DSL AST that drives the runtime TS via `fnFor`, so the two lowerings cannot diverge.
-- This file is a mechanical re-emission of 094 with the two new base pass-throughs added; the
-- derived `list_bucket`/`ack_open` expressions are unchanged. The drift guard now points at THIS
-- migration (the latest VIEW definition).
--
-- Forward-only VIEW definition (DROP then CREATE), sourced off the managed `pull_requests__tracking`
-- re-export of the base table so a terminated PR classifies on ENGINE TRUTH. SQLite does not validate
-- a view body at CREATE time. The runner wraps each file in its own transaction, so this file must
-- NOT contain BEGIN/COMMIT. Numbered after 103.

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
  pr.incident_message AS incident_message,
  pr.last_round_head AS last_round_head,
  pr.last_progress_job_key AS last_progress_job_key,
  pr.last_progress_result AS last_progress_result,
  pr.root_request_key AS root_request_key,
  pr.epic_phase_label AS epic_phase_label,
  pr.acknowledged_at AS acknowledged_at,
  CASE WHEN COALESCE((COALESCE((COALESCE(("pr"."derived_status" = 'merged'), 0) OR COALESCE(("pr"."derived_status" = 'converged'), 0) OR COALESCE(("pr"."derived_status" = 'abandoned'), 0) OR COALESCE(("pr"."derived_status" = 'closed'), 0) OR COALESCE(("pr"."derived_status" = 'failed'), 0)), 0) AND COALESCE(("pr"."acknowledged_at" = "pr"."acknowledged_at"), 0)), 0) THEN 'history' ELSE 'active' END AS list_bucket,
  CASE WHEN COALESCE((COALESCE((COALESCE(("pr"."derived_status" = 'merged'), 0) OR COALESCE(("pr"."derived_status" = 'converged'), 0) OR COALESCE(("pr"."derived_status" = 'abandoned'), 0) OR COALESCE(("pr"."derived_status" = 'closed'), 0) OR COALESCE(("pr"."derived_status" = 'failed'), 0)), 0) AND (NOT COALESCE(COALESCE(("pr"."acknowledged_at" = "pr"."acknowledged_at"), 0), 0))), 0) THEN 1 ELSE 0 END AS ack_open
FROM pull_requests__tracking pr;
