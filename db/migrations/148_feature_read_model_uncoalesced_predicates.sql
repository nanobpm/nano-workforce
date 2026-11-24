-- Re-create the `feature_read_model` VIEW from the CURRENT `sqlSelectFor` output.
-- @nanobpm/urban 0.100.0 (nano-ide#625) stopped COALESCE-wrapping projection predicates inside
-- EXISTS/WHERE/CASE, so SQLite can use its indexes (e.g. the `merges` lookup behind
-- `pull_requests_read_model`). The derived columns are emitted VERBATIM from app/featureReadModel.ts,
-- app/deliveryGraphReadModel.ts, app/planReadModel.ts and app/pullRequestReadModel.ts; the base
-- pass-throughs, display columns, FROM/JOINs are unchanged from 112 / 146 / 100 / 138 respectively.
-- Semantics are unchanged (the declarations' NULL handling is preserved by the new lowering — the
-- FRAMEWORK PARITY GUARDs check SQL↔TS agreement). No BEGIN/COMMIT (the runner wraps each file).
-- Numbered after 147.

DROP VIEW IF EXISTS feature_read_model;

CREATE VIEW feature_read_model AS
SELECT
  fr.feature_key AS feature_key,
  fr.repo AS repo,
  fr.issue_number AS issue_number,
  fr.issue_url AS issue_url,
  fr.title AS title,
  fr.base_branch AS base_branch,
  fr.status AS status,
  fr.process_key AS process_key,
  fr.pr_key AS pr_key,
  fr.converge AS converge,
  fr.auto_merge AS auto_merge,
  fr.outcome AS outcome,
  fr.delivery_label AS delivery_label,
  fr.acknowledged_at AS acknowledged_at,
  fr.created_at AS created_at,
  fr.updated_at AS updated_at,
  CASE WHEN (("fr"."derived_status" = 'merged') OR ("fr"."derived_status" = 'converged') OR ("fr"."derived_status" = 'blocked') OR ("fr"."derived_status" = 'failed') OR ("fr"."derived_status" = 'skipped') OR ("fr"."derived_status" = 'abandoned')) THEN 'Done' WHEN ("fr"."derived_status" = 'converging') THEN 'Converging' WHEN (("fr"."pr_key" <> '') OR ("fr"."derived_status" = 'opened')) THEN 'PR open' WHEN (("fr"."derived_status" = 'running') OR ("fr"."derived_status" = 'escalated') OR ("fr"."derived_status" = 'awaiting_operator')) THEN 'Implementing' ELSE 'Requested' END AS stage,
  CASE WHEN (("fr"."derived_status" = 'merged') OR ("fr"."derived_status" = 'converged')) THEN 'ok' WHEN ("fr"."derived_status" = 'blocked') THEN 'blocked' WHEN (("fr"."derived_status" = 'failed') OR ("fr"."derived_status" = 'skipped') OR ("fr"."derived_status" = 'abandoned')) THEN 'failed' ELSE NULL END AS stage_state,
  CASE WHEN (NOT COALESCE("fr"."converge", 0)) THEN 'Converging Merging' WHEN (NOT COALESCE("fr"."auto_merge", 0)) THEN 'Merging' ELSE '' END AS stage_skipped,
  CASE WHEN EXISTS (SELECT 1 FROM "user_tasks" AS "__urban_proj_0" WHERE (("__urban_proj_0"."subject_type" = 'feature') AND ("__urban_proj_0"."subject_key" = "fr"."feature_key") AND ("__urban_proj_0"."element_id" = 'feature-blocked'))) THEN 'blocked' WHEN EXISTS (SELECT 1 FROM "user_tasks" AS "__urban_proj_0" WHERE (("__urban_proj_0"."subject_type" = 'feature') AND ("__urban_proj_0"."subject_key" = "fr"."feature_key") AND ("__urban_proj_0"."element_id" = 'feature-escalation'))) THEN '⚠' ELSE NULL END AS attention,
  CASE WHEN (((("fr"."derived_status" = 'merged') OR ("fr"."derived_status" = 'converged') OR ("fr"."derived_status" = 'blocked') OR ("fr"."derived_status" = 'failed') OR ("fr"."derived_status" = 'skipped') OR ("fr"."derived_status" = 'abandoned') OR ("fr"."derived_status" = 'opened')) AND (NOT COALESCE(COALESCE((COALESCE(("fr"."derived_status" = 'opened'), 0) AND COALESCE(("fr"."converge" = 1), 0) AND COALESCE(("fr"."pr_key" = "fr"."pr_key"), 0)), 0), 0))) AND ("fr"."acknowledged_at" = "fr"."acknowledged_at")) THEN 'history' ELSE 'active' END AS list_bucket,
  CASE WHEN (((("fr"."derived_status" = 'merged') OR ("fr"."derived_status" = 'converged') OR ("fr"."derived_status" = 'blocked') OR ("fr"."derived_status" = 'failed') OR ("fr"."derived_status" = 'skipped') OR ("fr"."derived_status" = 'abandoned') OR ("fr"."derived_status" = 'opened')) AND (NOT COALESCE(COALESCE((COALESCE(("fr"."derived_status" = 'opened'), 0) AND COALESCE(("fr"."converge" = 1), 0) AND COALESCE(("fr"."pr_key" = "fr"."pr_key"), 0)), 0), 0))) AND (NOT COALESCE(COALESCE(("fr"."acknowledged_at" = "fr"."acknowledged_at"), 0), 0))) THEN 1 ELSE 0 END AS ack_open
FROM feature_runs__tracking fr;
