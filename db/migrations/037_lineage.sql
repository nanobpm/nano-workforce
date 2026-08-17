-- Lineage projection (issue #245): thread user intent → progress as one arc.
--
-- The lineage already exists in the data layer (feature_runs.pr_key ↔ pull_requests.pr_key,
-- plan_tasks.pr_key ↔ pull_requests.pr_key, and message correlation by prKey/planKey) but is not
-- projected as a single narrative. This migration adds the two pieces the read model needs:
--
--   1. `pull_requests.root_request_key` — the stable ORIGIN identity (the issue = feature_key /
--      plan_key) threaded onto every PR a request spawns. `submitPr` persists it and passes it as a
--      `createInstance` variable onto the convergence + merge instances; `startMerge` reads it back
--      off the row. A human-opened / webhook PR with no originating request is self-rooted by
--      `submitPr` (`root_request_key = pr_key`); a legacy pre-migration NULL is self-rooted the same
--      way by this migration's backfill (below), and the projection tolerates any residual NULL by
--      self-rooting on `pr_key`.
--
--   2. `lineage_threads` — a DERIVED read table, one row per `root_request_key` (or a self-rooted
--      PR's own key), recomputed idempotently each poll pass by `pollLineage` (app/lineage.ts) from
--      the existing gateway joins. It stitches `request → implementation run → PR(s) → convergence →
--      merge → outcome` into one ordered thread, exposing the active frontier (`stage`/`stage_label`/
--      `process_key`) plus whether the whole arc has settled (`active`). Urban's datasource cannot
--      read a SQL VIEW (gateway.ts schema() whitelists only type='table'), so — following the
--      codebase convention for read-model projections (`plans.delivery`, `feature_runs.delivery_label`)
--      — this is a denormalised flat table the schema-driven pages read directly.
--
-- Forward-only, additive (expand): a nullable column with no default, a new table/indexes, and a
-- self-rooting backfill of the new column. Numbered after the current highest prefix (036). The
-- runner wraps each file in its own transaction, so this file must NOT contain BEGIN/COMMIT.
ALTER TABLE pull_requests ADD COLUMN root_request_key TEXT;
CREATE INDEX IF NOT EXISTS idx_pr_root ON pull_requests(root_request_key);

-- Backfill: every pre-migration PR row has root_request_key = NULL. The projection self-roots such a
-- PR (keying its thread on `pr_key`), but a NULL row would then break the Lineage page's
-- `lineage_threads.root_request_key → pull_requests.root_request_key` drill-down join (thread key
-- `pr_key` ≠ stored NULL), rendering an empty PR list. Self-root each legacy row on its own pr_key,
-- exactly as `submitPr` self-roots a human/webhook PR going forward, so the join resolves. Idempotent.
UPDATE pull_requests SET root_request_key = pr_key WHERE root_request_key IS NULL;

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
