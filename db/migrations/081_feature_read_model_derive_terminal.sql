-- Feature-run read model: fold the ADR-0065 DERIVED terminal edge into the projection (issue #503 —
-- the feature_runs row of the "migrate remaining terminal-edge readers to derived_status" class).
--
-- Since ADR-0065 (`@nanobpm/urban@0.81.0`) the `instanceTracking` reconciler is a SOURCE, not a writer:
-- on cancel/terminate it feeds urban's instance projection and the terminal edge (`onTerminated →
-- abandoned`) is RECOMPUTED ON READ as `feature_runs__tracking.derived_status` — it NO LONGER writes
-- `abandoned` onto the base `feature_runs.status` column. `feature_runs` had NO derived reader, so a
-- terminated feature run's base row stayed frozen at `running`/`escalated`/`awaiting_operator` and
-- 076's `feature_read_model` rendered it "Implementing" (never "failed") on the Feature history grid
-- forever.
--
-- 076_feature_read_model_declare_once.sql authored the projection ONCE (`defineReadModel`,
-- app/featureReadModel.ts) and emitted each derived column VERBATIM from that declaration; it read the
-- base `feature_runs.status`. This migration SUPERSEDES 076's VIEW body: the declaration's `baseTable`
-- is now the auto-provisioned `feature_runs__tracking` derived VIEW (which re-exports `feature_runs.*`
-- plus a terminal-folded `derived_status`), and every status-classifying derived column below reads
-- `fr."derived_status"` instead of `fr."status"`. So a cancelled/terminated run renders `Done`/`failed`
-- with no worker write. 076 is a MERGED, IMMUTABLE migration — never edited; this is a NEW migration
-- superseding its VIEW body (the same pattern by which 076 superseded 073/075).
--
-- Every DERIVED column body is emitted VERBATIM from the ONE declaration
-- (`featureReadModel.sqlSelectFor(col, { baseAlias: "fr" })`), which ALSO drives the runtime TS via
-- `fnFor` — the two lowerings fall out of the same closed-DSL AST and cannot diverge. The drift guard
-- (app/featureReadModel.test.ts) fails if this file stops matching the declaration, and
-- `assertReadModelParity` proves the SQL and TS lowerings agree. SEMANTICS are unchanged from 076 EXCEPT
-- the status source (base transient → terminal-folded `derived_status`): `attention` still derives from
-- ENGINE TRUTH (an OPEN `user_tasks` row, issue #422); `stage_skipped` is still a pure function of
-- `converge`/`auto_merge`.
--
-- `feature_runs__tracking` is the managed VIEW urban provisions at mount (`<table>__tracking`); SQLite
-- does not validate a view body at CREATE time, so this migration (which runs before the runtime mount
-- that provisions the managed VIEW) is created fine and resolves once the managed VIEW exists. Base
-- columns stay aliased pass-throughs (so the static pages↔schema contract guard still sees the VIEW
-- columns), now sourced off `feature_runs__tracking`'s re-export of `base.*`; `feature_runs__tracking fr`
-- is the sole top-level FROM (the user_tasks lookups are nested EXISTS subqueries at paren depth >= 1).
--
-- Forward-only VIEW redefinition (DROP then CREATE). The runner wraps each file in its own transaction,
-- so this file must NOT contain BEGIN/COMMIT. Numbered after 079.

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
  CASE WHEN COALESCE((COALESCE(("fr"."derived_status" = 'merged'), 0) OR COALESCE(("fr"."derived_status" = 'converged'), 0) OR COALESCE(("fr"."derived_status" = 'blocked'), 0) OR COALESCE(("fr"."derived_status" = 'failed'), 0) OR COALESCE(("fr"."derived_status" = 'skipped'), 0) OR COALESCE(("fr"."derived_status" = 'abandoned'), 0)), 0) THEN 'Done' WHEN COALESCE(("fr"."derived_status" = 'converging'), 0) THEN 'Converging' WHEN COALESCE((COALESCE(("fr"."pr_key" <> ''), 0) OR COALESCE(("fr"."derived_status" = 'opened'), 0)), 0) THEN 'PR open' WHEN COALESCE((COALESCE(("fr"."derived_status" = 'running'), 0) OR COALESCE(("fr"."derived_status" = 'escalated'), 0) OR COALESCE(("fr"."derived_status" = 'awaiting_operator'), 0)), 0) THEN 'Implementing' ELSE 'Requested' END AS stage,
  CASE WHEN COALESCE((COALESCE(("fr"."derived_status" = 'merged'), 0) OR COALESCE(("fr"."derived_status" = 'converged'), 0)), 0) THEN 'ok' WHEN COALESCE(("fr"."derived_status" = 'blocked'), 0) THEN 'blocked' WHEN COALESCE((COALESCE(("fr"."derived_status" = 'failed'), 0) OR COALESCE(("fr"."derived_status" = 'skipped'), 0) OR COALESCE(("fr"."derived_status" = 'abandoned'), 0)), 0) THEN 'failed' ELSE NULL END AS stage_state,
  CASE WHEN (NOT COALESCE("fr"."converge", 0)) THEN 'Converging Merging' WHEN (NOT COALESCE("fr"."auto_merge", 0)) THEN 'Merging' ELSE '' END AS stage_skipped,
  CASE WHEN EXISTS (SELECT 1 FROM "user_tasks" AS "__urban_proj_0" WHERE COALESCE((COALESCE(("__urban_proj_0"."subject_type" = 'feature'), 0) AND COALESCE(("__urban_proj_0"."subject_key" = "fr"."feature_key"), 0) AND COALESCE(("__urban_proj_0"."element_id" = 'feature-blocked'), 0)), 0)) THEN 'blocked' WHEN EXISTS (SELECT 1 FROM "user_tasks" AS "__urban_proj_0" WHERE COALESCE((COALESCE(("__urban_proj_0"."subject_type" = 'feature'), 0) AND COALESCE(("__urban_proj_0"."subject_key" = "fr"."feature_key"), 0) AND COALESCE(("__urban_proj_0"."element_id" = 'feature-escalation'), 0)), 0)) THEN '⚠' ELSE NULL END AS attention,
  CASE WHEN COALESCE((COALESCE((COALESCE(("fr"."derived_status" = 'merged'), 0) OR COALESCE(("fr"."derived_status" = 'converged'), 0) OR COALESCE(("fr"."derived_status" = 'blocked'), 0) OR COALESCE(("fr"."derived_status" = 'failed'), 0) OR COALESCE(("fr"."derived_status" = 'skipped'), 0) OR COALESCE(("fr"."derived_status" = 'abandoned'), 0)), 0) AND COALESCE(("fr"."acknowledged_at" = "fr"."acknowledged_at"), 0)), 0) THEN 'history' ELSE 'active' END AS list_bucket
FROM feature_runs__tracking fr;
