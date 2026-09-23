-- 110_task_completions_auto_applied.sql — issue #806 (Copilot review): mark an AUTO-APPLIED escalation
-- completion so it is distinguishable from a fresh human/agent submission in the attribution ledger.
--
-- The convergence poller auto-resumes an already-answered `wait-answer` by replaying a durable
-- adjudication through the SAME `completeUserTaskAttributed` door a human/agent uses (app/service.ts,
-- issue #806). Without a marker that replay is INDISTINGUISHABLE from a real, first-hand submission in
-- `task_completions`, and — recorded as an irreversible authority — it could launder an earlier
-- agent-originated decision into an unchallengeable human one. `auto_applied=1` records "this
-- completion is a machine replay of a prior decision, not a fresh submission"; the app also records
-- such completions `reversible=1` so a human can always override an auto-applied answer.
--
-- Forward-only, additive (expand): a nullable-defaulted `ADD COLUMN`, so every existing completion
-- reads back `auto_applied=0` (a genuine first-hand submission). Numbered after 109 in the pre-assigned
-- 109–110 block (#806); the runner wraps each file in its own transaction, so no BEGIN/COMMIT here.
ALTER TABLE task_completions ADD COLUMN auto_applied INTEGER NOT NULL DEFAULT 0;

-- Link an AUTO-APPLIED escalation completion back to the durable adjudication it replayed (issue #806,
-- Copilot review), so a human's revert of that completion can invalidate the exact decision. The
-- convergence poller auto-resumes an already-answered `wait-answer` by replaying a `pr_adjudications`
-- row through `completeEscalationAutoApplied` (app/service.ts); recording WHICH adjudication it replayed
-- lets `revertAgentCompletion` tombstone that decision (`invalidateAdjudication`) so the revert becomes a
-- real override — the next round re-parks a human — instead of the poller silently re-applying the same
-- overridden answer. NULL for every first-hand (human/agent) submission and for legacy rows; only an
-- auto-apply carries a source adjudication. Additive (expand): a nullable `ADD COLUMN`. Folded into this
-- file to keep the whole change inside the pre-assigned 109–110 block (#806, Copilot review) rather than
-- consuming an unallocated 111 prefix.
ALTER TABLE task_completions ADD COLUMN source_adjudication_id INTEGER;

-- `latestAdjudicator` (workers/answer-escalation) now looks a completion up by `process_instance_key`
-- for every convergence answer, to correlate the settled adjudicator's attribution (#806). The ledger
-- is append-only and only carried an index on `user_task_key` (026_agent_completion.sql), so that
-- lookup would scan the whole completion history as the fleet grows. Index `process_instance_key` too
-- (additive/expand — a new index, no existing shape touched).
CREATE INDEX idx_task_completions_pik ON task_completions(process_instance_key);
