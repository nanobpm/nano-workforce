-- Agent-answerable escalations (epic #156, slice U6; ADR 0046). The escalation user tasks landed by
-- U0–U3 are completed by whoever holds the assignment — a human via the task inbox, or an AGENT
-- assignee via the host-side completer. Both drive the SAME `.form` contract and the SAME engine
-- `completeUserTask` resume path (no parallel lane); this ledger is the attribution + reversibility
-- surface layered over that one completion.
--
-- One row per escalation user-task completion routed through the canonical attributed completer
-- (app/agentCompletion.ts). It records WHO completed the task (agent vs human, and their id), the
-- exact typed form variables submitted, and — for an AGENT completion — whether a human has since
-- reverted/overridden it. A completed user task cannot be un-completed in the engine, so
-- reversibility is modelled here: an agent answer is never a silent irreversible commit — a human
-- can mark it reverted (recording who + when), and any host-side consumer reads this ledger to see
-- whether the latest completion is still authoritative.
--
-- Expand-only / additive (AGENTS.md forward-only migrations): a new table, no existing shape
-- touched. `actor_kind` is agent | human; `reversible` is 1 for agent completions (a human may
-- override) and 0 for human completions (already the authority).
CREATE TABLE task_completions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_task_key         TEXT NOT NULL,             -- the engine user-task key that was completed
  process_instance_key  TEXT,                      -- owning process instance, when known
  element_id            TEXT,                      -- the escalation task's BPMN elementId
  actor_kind            TEXT NOT NULL,             -- agent | human
  actor_id              TEXT NOT NULL,             -- the completing identity (agent id / operator)
  variables_json        TEXT NOT NULL,             -- the typed form variables submitted (JSON)
  reversible            INTEGER NOT NULL DEFAULT 0, -- 1 = a human may override (agent completions)
  reverted              INTEGER NOT NULL DEFAULT 0, -- 1 once a human has reverted/overridden it
  reverted_by           TEXT,                      -- the human identity that reverted it
  reverted_note         TEXT,                      -- the human's corrective guidance overriding the agent answer
  reverted_at           TEXT,
  created_at            TEXT NOT NULL
);

-- The completer and the revert path look a completion up by its user-task key (newest first);
-- index it to avoid a scan.
CREATE INDEX idx_task_completions_key ON task_completions(user_task_key);
