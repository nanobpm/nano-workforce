-- Planning fan-out (issue #14): a planning agent decomposes an issue into tasks,
-- a fleet of implementation agents build them in parallel, each opening a PR that
-- is then enrolled into the review-convergence loop.
--
-- `plans` is one row per issue put through the fleet; `plan_tasks` is one row per
-- slice the planner emitted, tracking the PR it produced and its dispatch state.

CREATE TABLE plans (
  plan_key      TEXT PRIMARY KEY,          -- "<owner>/<repo>#<issue-number>"
  repo          TEXT NOT NULL,             -- "<owner>/<repo>"
  issue_number  INTEGER NOT NULL,
  issue_url     TEXT NOT NULL,
  title         TEXT,                       -- issue title (best-effort)
  status        TEXT NOT NULL,             -- planning | dispatched | done | failed | abandoned
  task_count    INTEGER NOT NULL DEFAULT 0,
  process_key   TEXT,                       -- engine process-instance key
  outcome       TEXT,                       -- final summary / note
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE plan_tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_key    TEXT NOT NULL REFERENCES plans(plan_key),
  task_index  INTEGER NOT NULL,            -- position in the plan (aligns with the MI output collection)
  task_id     TEXT NOT NULL,               -- planner-supplied slug (or "t<index>")
  title       TEXT,
  prompt      TEXT,
  status      TEXT NOT NULL,               -- pending | opened | blocked | skipped | escalated | waiting-for-lane | abandoned
  pr_key      TEXT,                         -- the PR this slice produced ("<owner>/<repo>#<n>")
  summary     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX idx_plans_status ON plans(status);
CREATE INDEX idx_plan_tasks_plan ON plan_tasks(plan_key);
