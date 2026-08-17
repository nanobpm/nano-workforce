-- Lineage projection (issue #245): thread user intent → progress as one arc.
--
-- The lineage already exists in the data layer (feature_runs.pr_key ↔ pull_requests.pr_key,
-- plan_tasks.pr_key ↔ pull_requests.pr_key, and message correlation by prKey/planKey) but is not
-- projected as a single narrative. This migration adds the two pieces the read model needs:
--
--   1. `pull_requests.root_request_key` — the stable ORIGIN identity (the issue = feature_key /
--      plan_key) threaded onto every PR a request spawns. `submitPr` persists it and passes it as a
--      `createInstance` variable onto the convergence + merge instances; `startMerge` reads it back
--      off the row. Human-opened / webhook PRs with no originating request keep it NULL — they are
--      their own root, and the projection tolerates that.
--
--   2. `lineage_threads` — a DERIVED read table, one row per `root_request_key` (or a self-rooted
--      PR when NULL), recomputed idempotently each poll pass by `pollLineage` (app/lineage.ts) from
--      the existing gateway joins. It stitches `request → implementation run → PR(s) → convergence →
--      merge → outcome` into one ordered thread, exposing the active frontier (`stage`/`stage_label`/
--      `process_key`) plus whether the whole arc has settled (`active`). Urban's datasource cannot
--      read a SQL VIEW (gateway.ts schema() whitelists only type='table'), so — following the
--      codebase convention for read-model projections (`plans.delivery`, `feature_runs.delivery_label`)
--      — this is a denormalised flat table the schema-driven pages read directly.
--
-- Forward-only, additive (expand): a nullable column with no default and a new table/indexes.
-- Numbered after the current highest prefix (036). The runner wraps each file in its own
-- transaction, so this file must NOT contain BEGIN/COMMIT.
ALTER TABLE pull_requests ADD COLUMN root_request_key TEXT;
CREATE INDEX IF NOT EXISTS idx_pr_root ON pull_requests(root_request_key);

CREATE TABLE IF NOT EXISTS lineage_threads (
  root_request_key TEXT PRIMARY KEY,        -- origin issue key (feature_key/plan_key), or a self-rooted pr_key
  kind             TEXT NOT NULL,            -- feature | epic | pr
  title            TEXT,                     -- best-effort origin/PR title
  issue_url        TEXT,                     -- origin issue URL (NULL for self-rooted PRs)
  stage            TEXT NOT NULL,            -- active-frontier machine label (implementing|converging|merged|…)
  stage_label      TEXT,                     -- human narrative rollup for the timeline
  process_key      TEXT,                     -- active-frontier process instance (for the processExplorer link)
  pr_keys          TEXT,                     -- JSON array of the member PR keys (fan-out for epics)
  pr_count         INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1, -- 1 while the arc has an active frontier, 0 once settled
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lineage_active ON lineage_threads(active);
