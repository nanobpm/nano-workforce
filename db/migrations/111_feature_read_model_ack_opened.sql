-- Feature-run read model: widen the DISMISSABLE-terminal set of the `list_bucket` / `ack_open` derived
-- columns to include `opened` (issue #808). SUPERSEDES 099's VIEW body — every DERIVED column is
-- emitted VERBATIM from the ONE declaration in app/featureReadModel.ts, now with `list_bucket`/
-- `ack_open` parameterised by the WIDER `FEATURE_ACK_TERMINAL_STATUSES` (= `STAGE_DONE_STATUSES` +
-- `opened`) instead of `STAGE_DONE_STATUSES`. 099 is a MERGED, IMMUTABLE migration — never edited; this
-- is a NEW migration superseding its VIEW body (the same pattern by which 099 superseded 081, 081
-- superseded 076).
--
-- WHY. A raise-only feature run (converge not requested) ends at status `opened` after raising its PR.
-- Issue #808 folds a COMPLETED such run's frozen `running` status to `opened` (`deriveFeatureCompletion`
-- / `foldCompletedFeatureRun`) so it stops wedging in the Active bucket. But `opened` is deliberately a
-- LIVE `PR open` pipeline STAGE, NOT a `Done` status, so it was excluded from `STAGE_DONE_STATUSES` —
-- the set the `list_bucket`/`ack_open` derivations used. Result: the folded run had `ack_open=0` and
-- `list_bucket='active'`, so `acknowledgeDone` still 409'd ("feature run is not terminal") and the run
-- stayed wedged in Active — the exact wedge #808 aims to fix. This DECOUPLES the ack/History terminal
-- set from the stage-`Done` set: `opened` is now dismissable into History (so a finished raise-only run
-- can be ticked off) while the STAGE derivations still classify on `STAGE_DONE_STATUSES`, so the
-- pipeline renders `opened` as `PR open`, never `Done`.
--
-- Every DERIVED column below is emitted VERBATIM from `featureReadModel.sqlSelectFor(col,
-- { baseAlias: "fr" })` (which ALSO drives the runtime TS via `fnFor`); the `stage`/`stage_state`/
-- `stage_skipped`/`attention` bodies are UNCHANGED from 099 and only `list_bucket`/`ack_open` gain the
-- `'opened'` disjunct. The drift guard (app/featureReadModel.test.ts) fails if this file stops matching
-- the declaration, and `assertReadModelParity` proves the SQL and TS lowerings agree.
--
-- SEMANTICS unchanged from 099 EXCEPT the two `opened`-widened columns: the status-classifying columns
-- still read the terminal-folded `feature_runs__tracking.derived_status`; base columns stay aliased
-- identity pass-throughs; `acknowledged_at` still passes through so the read model can classify on it.
--
-- Forward-only VIEW redefinition (DROP then CREATE). `feature_runs__tracking` is the managed VIEW urban
-- provisions at mount; SQLite does not validate a view body at CREATE time, so this migration (which
-- runs before that mount) is created fine and resolves once the managed VIEW exists. The runner wraps
-- each file in its own transaction, so this file must NOT contain BEGIN/COMMIT. Numbered after 110.

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
  CASE WHEN COALESCE((COALESCE((COALESCE(("fr"."derived_status" = 'merged'), 0) OR COALESCE(("fr"."derived_status" = 'converged'), 0) OR COALESCE(("fr"."derived_status" = 'blocked'), 0) OR COALESCE(("fr"."derived_status" = 'failed'), 0) OR COALESCE(("fr"."derived_status" = 'skipped'), 0) OR COALESCE(("fr"."derived_status" = 'abandoned'), 0) OR COALESCE(("fr"."derived_status" = 'opened'), 0)), 0) AND COALESCE(("fr"."acknowledged_at" = "fr"."acknowledged_at"), 0)), 0) THEN 'history' ELSE 'active' END AS list_bucket,
  CASE WHEN COALESCE((COALESCE((COALESCE(("fr"."derived_status" = 'merged'), 0) OR COALESCE(("fr"."derived_status" = 'converged'), 0) OR COALESCE(("fr"."derived_status" = 'blocked'), 0) OR COALESCE(("fr"."derived_status" = 'failed'), 0) OR COALESCE(("fr"."derived_status" = 'skipped'), 0) OR COALESCE(("fr"."derived_status" = 'abandoned'), 0) OR COALESCE(("fr"."derived_status" = 'opened'), 0)), 0) AND (NOT COALESCE(COALESCE(("fr"."acknowledged_at" = "fr"."acknowledged_at"), 0), 0))), 0) THEN 1 ELSE 0 END AS ack_open
FROM feature_runs__tracking fr;
