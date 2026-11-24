-- The round budget (`maxRounds`) a PR run was submitted with (issue #1088). Without it a custom budget
-- was silently reset to the default on lifecycle handoffs (merge->convergence, feature re-enroll),
-- which restarted the loop with MAX_ROUNDS, and `/run` read it from a loop that may not own the run.
-- `submitPr` stamps it at submit/reopen; a handoff/re-enroll passes it back. NULL = default/pre-154.
ALTER TABLE pull_requests ADD COLUMN max_rounds INTEGER;
