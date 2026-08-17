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
--      `submitPr` (`root_request_key = pr_key`); a legacy pre-migration NULL is backfilled below to
--      the SAME root submitPr would persist (feature/epic origin key, else self-rooted pr_key), and
--      the projection tolerates any residual NULL by self-rooting on `pr_key`.
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
-- Forward-only, additive (expand): a nullable column with no default, a new table/indexes, and an
-- origin-aware backfill of the new column. Numbered after the current highest prefix (036). The
-- runner wraps each file in its own transaction, so this file must NOT contain BEGIN/COMMIT.
ALTER TABLE pull_requests ADD COLUMN root_request_key TEXT;
CREATE INDEX IF NOT EXISTS idx_pr_root ON pull_requests(root_request_key);

-- Backfill: every pre-migration PR row has root_request_key = NULL, which breaks the Lineage page's
-- `lineage_threads.root_request_key → pull_requests.root_request_key` drill-down join (a NULL never
-- matches a thread key), rendering an empty PR list. Backfill each row with the SAME root `submitPr`
-- persists going forward, so the join resolves for already-tracked PRs at deploy time too:
--   1. a PR spawned by a feature run roots on its origin `feature_runs.feature_key` (submitPr passes
--      `featureKey` — workers/converge-feature);
--   2. a PR spawned by an epic slice roots on its origin `plan_tasks.plan_key` (submitPr passes
--      `planKey` — workers/record-wave);
--   3. any remaining origin-less PR (human/webhook, or an origin row that no longer survives) is
--      self-rooted on its own `pr_key`, exactly as `submitPr` self-roots a human/webhook PR.
-- Origin-aware steps run first so a tracked PR keeps its true origin key rather than being self-rooted
-- (which would orphan it from its feature/epic thread in the drill-down). All idempotent.
UPDATE pull_requests SET root_request_key = (
    SELECT fr.feature_key FROM feature_runs fr WHERE fr.pr_key = pull_requests.pr_key
  )
  WHERE root_request_key IS NULL
    AND EXISTS (SELECT 1 FROM feature_runs fr WHERE fr.pr_key = pull_requests.pr_key);
UPDATE pull_requests SET root_request_key = (
    SELECT pt.plan_key FROM plan_tasks pt WHERE pt.pr_key = pull_requests.pr_key
  )
  WHERE root_request_key IS NULL
    AND EXISTS (SELECT 1 FROM plan_tasks pt WHERE pt.pr_key = pull_requests.pr_key);
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
