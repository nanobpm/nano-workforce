-- Epic retrospective — the post-completion reflection stage (blackboard `learning` follow-up).
--
-- An epic (a `plans` row) is dispatched by `plan-fanout` and its slices land asynchronously,
-- each PR riding its own `merge-loop`. "Epic complete" is therefore emergent: it is the moment
-- the LAST of a plan's PRs reaches a terminal state (merged / converged / abandoned). When that
-- happens, `maybeStartRetro` (app/retro.ts) starts one `retro` process instance for the plan.
--
-- The retro agent (`senior:retro`) reads the plan's accumulated coordination knowledge — the
-- `learning` blackboard entries agents posted while implementing, plus their task deltas and
-- escalations — clusters and ranks it, and opens a PR against the TARGET repo promoting the
-- recurring gotchas into that repo's AGENTS.md / a script / a CI step (human-reviewed, never
-- auto-committed). The report it produces is recorded here.

-- Fire-once guard. Set (to an ISO timestamp) the instant `maybeStartRetro` starts the retro
-- process for this plan, so a second PR of the same plan reaching terminal state near-simultaneously
-- cannot start a duplicate retro. NULL = no retro has been started for this plan.
ALTER TABLE plans ADD COLUMN retro_started_at TEXT;

-- One row per epic retrospective. Written by `pr.retro-record` from the `senior:retro` agent's
-- result. Advisory knowledge, like the blackboard it distils — it gates no control flow.
CREATE TABLE plan_retros (
  plan_key      TEXT PRIMARY KEY REFERENCES plans(plan_key),
  status        TEXT NOT NULL,               -- filed | skipped | blocked (the agent's result status)
  pr_key        TEXT,                         -- the promotion PR the agent opened on the target repo ("<owner>/<repo>#<n>"), or NULL
  learnings     INTEGER NOT NULL DEFAULT 0,  -- raw count of `learning` blackboard entries included in the retro digest
  summary       TEXT,                         -- the agent's human-readable retro summary
  report        TEXT,                         -- the full retro report / transcript (nullable)
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
