-- Feature-run read model: DECLARE ONCE, compile to BOTH backends (ADR-0065, nano-ide#452).
--
-- This migration SUPERSEDES the hand-wired `feature_read_model` VIEW of 073_feature_read_model.sql and
-- 075_feature_read_model_attention_from_user_tasks.sql. Those authored each derived column TWICE — the
-- SQL CASE/EXISTS here AND the TypeScript oracle (deriveStage/deriveListBucket, app/stage.ts) — kept in
-- lockstep by a hand-written parity test (drift surface #2, ADR-0065). This VIEW is no longer
-- hand-written: every DERIVED column body below is emitted VERBATIM from the ONE declaration in
-- app/featureReadModel.ts (`featureReadModel.sqlSelectFor(col, { baseAlias: "fr" })`), which ALSO drives the
-- runtime TS via `fnFor` — the two lowerings fall out of the same closed-DSL AST and cannot diverge.
-- A drift guard (app/featureReadModel.test.ts) fails if this file stops matching the declaration, and
-- `assertReadModelParity` proves the SQL and TS lowerings agree.
--
-- SEMANTICS ARE UNCHANGED from 075: `attention` still derives from ENGINE TRUTH — an OPEN native user
-- task in the `user_tasks` inbox (a `feature-blocked` row => blocked glyph, a `feature-escalation` row
-- => `?`), NOT the drift-prone `status` variable (issue #422); `stage`/`stage_state`/`stage_skipped`/
-- `list_bucket` are the same pure functions of the row. Only the AUTHORING moves to the framework
-- primitive; the projected values are identical.
--
-- Forward-only VIEW redefinition (DROP then CREATE). 073/075 are MERGED, IMMUTABLE migrations — never
-- edited; this is a NEW migration superseding their VIEW body. `feature_runs` (028+) and `user_tasks`
-- (034) already exist earlier in the chain, and 075 already created the supporting
-- `idx_user_tasks_subject_element` index the correlated attention EXISTS lookups seek, so it is not
-- re-created here. Base columns are plain identity pass-throughs (aliased so the static pages<->schema
-- contract guard sees the VIEW columns); `feature_runs fr` stays the sole top-level FROM (the user_tasks
-- lookups are nested EXISTS subqueries at paren depth >= 1). The runner wraps each file in its own
-- transaction, so this file must NOT contain BEGIN/COMMIT.

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
  CASE WHEN COALESCE((COALESCE(("fr"."status" = 'merged'), 0) OR COALESCE(("fr"."status" = 'converged'), 0) OR COALESCE(("fr"."status" = 'blocked'), 0) OR COALESCE(("fr"."status" = 'failed'), 0) OR COALESCE(("fr"."status" = 'skipped'), 0) OR COALESCE(("fr"."status" = 'abandoned'), 0)), 0) THEN 'Done' WHEN COALESCE(("fr"."status" = 'converging'), 0) THEN 'Converging' WHEN COALESCE((COALESCE(("fr"."pr_key" <> ''), 0) OR COALESCE(("fr"."status" = 'opened'), 0)), 0) THEN 'PR open' WHEN COALESCE((COALESCE(("fr"."status" = 'running'), 0) OR COALESCE(("fr"."status" = 'escalated'), 0) OR COALESCE(("fr"."status" = 'awaiting_operator'), 0)), 0) THEN 'Implementing' ELSE 'Requested' END AS stage,
  CASE WHEN COALESCE((COALESCE(("fr"."status" = 'merged'), 0) OR COALESCE(("fr"."status" = 'converged'), 0)), 0) THEN 'ok' WHEN COALESCE(("fr"."status" = 'blocked'), 0) THEN 'blocked' WHEN COALESCE((COALESCE(("fr"."status" = 'failed'), 0) OR COALESCE(("fr"."status" = 'skipped'), 0) OR COALESCE(("fr"."status" = 'abandoned'), 0)), 0) THEN 'failed' ELSE NULL END AS stage_state,
  CASE WHEN (NOT COALESCE("fr"."converge", 0)) THEN 'Converging Merging' WHEN (NOT COALESCE("fr"."auto_merge", 0)) THEN 'Merging' ELSE '' END AS stage_skipped,
  CASE WHEN EXISTS (SELECT 1 FROM "user_tasks" AS "__urban_proj_0" WHERE COALESCE((COALESCE(("__urban_proj_0"."subject_type" = 'feature'), 0) AND COALESCE(("__urban_proj_0"."subject_key" = "fr"."feature_key"), 0) AND COALESCE(("__urban_proj_0"."element_id" = 'feature-blocked'), 0)), 0)) THEN 'blocked' WHEN EXISTS (SELECT 1 FROM "user_tasks" AS "__urban_proj_0" WHERE COALESCE((COALESCE(("__urban_proj_0"."subject_type" = 'feature'), 0) AND COALESCE(("__urban_proj_0"."subject_key" = "fr"."feature_key"), 0) AND COALESCE(("__urban_proj_0"."element_id" = 'feature-escalation'), 0)), 0)) THEN '⚠' ELSE NULL END AS attention,
  CASE WHEN COALESCE((COALESCE((COALESCE(("fr"."status" = 'merged'), 0) OR COALESCE(("fr"."status" = 'converged'), 0) OR COALESCE(("fr"."status" = 'blocked'), 0) OR COALESCE(("fr"."status" = 'failed'), 0) OR COALESCE(("fr"."status" = 'skipped'), 0) OR COALESCE(("fr"."status" = 'abandoned'), 0)), 0) AND "fr"."acknowledged_at"), 0) THEN 'history' ELSE 'active' END AS list_bucket
FROM feature_runs fr;
