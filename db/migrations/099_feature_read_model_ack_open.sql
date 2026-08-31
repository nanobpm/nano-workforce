-- Feature-run read model: fold the operator "Dismiss" affordance flag `ack_open` into the
-- `feature_read_model` VIEW (issue #654). SUPERSEDES 081's VIEW body — every DERIVED column is emitted
-- VERBATIM from the ONE declaration in app/featureReadModel.ts, now extended with the shared Dismiss-
-- affordance oracle (app/listBucket.ts `deriveAckOpenExpr`). 081 is a MERGED, IMMUTABLE migration —
-- never edited; this is a NEW migration superseding its VIEW body (the same pattern by which 081
-- superseded 076, and 096/097 added `ack_open` to the Delivery-Graph / Plan read models).
--
-- WHY. `acknowledgeDone` was the one acknowledge op still gating on the base `feature_runs.status`
-- allowlist (`STAGE_DONE_STATUSES.includes(run.status)`) while its Dismiss button rendered off the
-- read model — a latent twin of the PR drift (#652): when an out-of-band terminate freezes base
-- `status` non-terminal but the tracking VIEW folds `derived_status='abandoned'`, the button showed
-- Dismiss yet the op 409'd. Issue #654 gates every acknowledge op on the read model's `ack_open` (the
-- single oracle both the button and the guard consume), which requires `feature_read_model` to expose
-- `ack_open` uniformly with the other three surfaces. This VIEW adds that declared `ack_open` column.
--
-- Every DERIVED column below is emitted VERBATIM from `featureReadModel.sqlSelectFor(col,
-- { baseAlias: "fr" })` (which ALSO drives the runtime TS via `fnFor`); the `stage`/`stage_state`/
-- `stage_skipped`/`attention`/`list_bucket` bodies are unchanged from 081 and `ack_open` is the ONE new
-- derived column (terminal ∧ unacknowledged, from the shared oracle over `STAGE_DONE_STATUSES`). The
-- drift guard (app/featureReadModel.test.ts) fails if this file stops matching the declaration, and
-- `assertReadModelParity` proves the SQL and TS lowerings agree.
--
-- SEMANTICS unchanged from 081 EXCEPT the one new `ack_open` column: the status-classifying columns
-- still read the terminal-folded `feature_runs__tracking.derived_status`; base columns stay aliased
-- identity pass-throughs; `acknowledged_at` still passes through so the read model can classify on it.
--
-- Forward-only VIEW redefinition (DROP then CREATE). `feature_runs__tracking` is the managed VIEW urban
-- provisions at mount; SQLite does not validate a view body at CREATE time, so this migration (which
-- runs before that mount) is created fine and resolves once the managed VIEW exists. The runner wraps
-- each file in its own transaction, so this file must NOT contain BEGIN/COMMIT. Numbered after 098.

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
  CASE WHEN COALESCE((COALESCE((COALESCE(("fr"."derived_status" = 'merged'), 0) OR COALESCE(("fr"."derived_status" = 'converged'), 0) OR COALESCE(("fr"."derived_status" = 'blocked'), 0) OR COALESCE(("fr"."derived_status" = 'failed'), 0) OR COALESCE(("fr"."derived_status" = 'skipped'), 0) OR COALESCE(("fr"."derived_status" = 'abandoned'), 0)), 0) AND COALESCE(("fr"."acknowledged_at" = "fr"."acknowledged_at"), 0)), 0) THEN 'history' ELSE 'active' END AS list_bucket,
  CASE WHEN COALESCE((COALESCE((COALESCE(("fr"."derived_status" = 'merged'), 0) OR COALESCE(("fr"."derived_status" = 'converged'), 0) OR COALESCE(("fr"."derived_status" = 'blocked'), 0) OR COALESCE(("fr"."derived_status" = 'failed'), 0) OR COALESCE(("fr"."derived_status" = 'skipped'), 0) OR COALESCE(("fr"."derived_status" = 'abandoned'), 0)), 0) AND (NOT COALESCE(COALESCE(("fr"."acknowledged_at" = "fr"."acknowledged_at"), 0), 0))), 0) THEN 1 ELSE 0 END AS ack_open
FROM feature_runs__tracking fr;
