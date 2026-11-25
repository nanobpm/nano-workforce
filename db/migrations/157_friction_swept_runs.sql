-- 157_friction_swept_runs.sql — #1098 review: a per-run ledger of agent runs whose history a friction
-- sweep has FULLY read. The watermark alone cannot express "run R1 at instant T was read but its
-- tie R2 at the same T was not", nor "a late-visible overlap run was skipped by the byte cap"; the
-- ledger lets each sweep skip already-swept runs and re-read only the unread ones, while the
-- watermark never advances past an unread run. Rows older than the overlap horizon are pruned.
--
-- EXPAND only. The runner wraps each file in its own transaction, so no BEGIN/COMMIT here.
CREATE TABLE IF NOT EXISTS friction_swept_runs (
  run_key     TEXT PRIMARY KEY,  -- agentInstanceKey
  run_instant TEXT NOT NULL,     -- ISO ts the run was windowed on (for pruning)
  sweep_key   TEXT NOT NULL,
  swept_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS friction_swept_runs_instant ON friction_swept_runs (run_instant);
