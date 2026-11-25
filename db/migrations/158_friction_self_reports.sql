-- 158_friction_self_reports.sql — issue #1101: agents self-report friction in their result.
--
-- Every `senior:*` agent may return an optional `friction` array in its canonical result
-- (`[{ what, turnsLost?, surface, suggestedFix?, targetRepo? }]`, app/friction.ts
-- `AgentFrictionNote`). The engine propagates the result key verbatim as a process variable; the
-- record worker captures each reported note — REDACTED with the collector's redactor — into this table with
-- its run linkage (owning process instance + the capturing record job's element instance). The record
-- worker following each agent task captures them (`captureFrictionFromJob`). `pr.friction-collect` then reads the rows in its window as the
-- `self_reported` signal kind.
--
-- EXPAND only. The runner wraps each file in its own transaction, so no BEGIN/COMMIT here.
CREATE TABLE IF NOT EXISTS friction_self_reports (
  id                   TEXT PRIMARY KEY,  -- sha256(processInstanceKey, note) — idempotent per run + note
  process_instance_key TEXT,              -- the run (canonical run identity `pi:<key>`)
  scope_key            TEXT,              -- element instance of the capturing record job (NULL when the adapter omits it)
  job_key              TEXT,              -- the capturing record job's key (always supplied by the Urban adapter)
  what                 TEXT NOT NULL,     -- redacted
  surface              TEXT NOT NULL,     -- one of FIX_SURFACES
  turns_lost           INTEGER,
  suggested_fix        TEXT,              -- redacted
  target_repo          TEXT,
  captured_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_friction_self_reports_captured ON friction_self_reports (captured_at);

ALTER TABLE friction_sweeps ADD COLUMN self_reported_count INTEGER NOT NULL DEFAULT 0;

