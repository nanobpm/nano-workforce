-- Single-issue feature run (issue #172): the "missing middle" between Epics
-- (plan-fanout: one issue → many PRs) and PR convergence (an already-open PR →
-- review → merge). One row per issue handed to a single implementation agent
-- that raises exactly ONE PR, then OPTIONALLY hands that PR to the convergence
-- loop (and, with auto-merge, the merge-loop).
--
-- The downstream PR lifecycle (review rounds, escalations, merge) is NOT
-- duplicated here: once `converge` hands the opened PR to `submitPr`, its live
-- state lives on the `pull_requests` row keyed by `pr_key`. `feature_runs` only
-- tracks the feature run's own lifecycle up to the hand-off.

CREATE TABLE feature_runs (
  feature_key   TEXT PRIMARY KEY,          -- "<owner>/<repo>#<issue-number>"
  repo          TEXT NOT NULL,             -- "<owner>/<repo>"
  issue_number  INTEGER NOT NULL,
  issue_url     TEXT NOT NULL,
  base_branch   TEXT NOT NULL,             -- the branch the agent branches off / opens its PR against
  status        TEXT NOT NULL,             -- running | opened | converging | blocked | skipped | failed | abandoned
  process_key   TEXT,                       -- engine process-instance key (feature.bpmn)
  pr_key        TEXT,                       -- the PR this run produced ("<owner>/<repo>#<n>") → pull_requests
  converge      INTEGER NOT NULL DEFAULT 0, -- 0|1 — hand the opened PR to the convergence loop
  auto_merge    INTEGER NOT NULL DEFAULT 0, -- 0|1 — drive the merge-loop after convergence (converge=0 ⇒ moot)
  outcome       TEXT,                       -- final summary / note from the agent
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX idx_feature_runs_status ON feature_runs(status);
