-- Backfill legacy NULL/blank titles so the title-led grids (issue #248) never
-- render a blank identity cell for pre-#248 rows.
--
-- 035_feature_runs_title.sql added `feature_runs.title` nullable, and both
-- `plans.title` (004_planning.sql) and `pull_requests.title` (001_init.sql) have
-- long allowed NULL. The dispatch/overview grids now render `template: "{{title}}"`
-- directly off these tables with NO key fallback, so any historical row whose title
-- is NULL or blank shows as an unlabeled row. `startPlan`/`startFeature`/the PR
-- upsert already coalesce title to the `owner/repo#N` key at write time; this
-- migration applies the same coalesce once to the rows that predate that behaviour.
--
-- Forward-only, additive (data-only): sets title to the row's key where it is
-- currently NULL or blank. Idempotent — re-running is a no-op once titles are set.
-- Numbered after the current highest prefix on origin/main (035); the runner wraps
-- each file in its own transaction, so this file must NOT contain BEGIN/COMMIT.
UPDATE plans         SET title = plan_key    WHERE title IS NULL OR trim(title) = '';
UPDATE feature_runs  SET title = feature_key WHERE title IS NULL OR trim(title) = '';
UPDATE pull_requests SET title = pr_key      WHERE title IS NULL OR trim(title) = '';
