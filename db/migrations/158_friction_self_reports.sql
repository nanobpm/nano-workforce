-- 158_friction_self_reports.sql — issue #1101: agents self-report friction in their result.
--
-- Every `senior:*` agent may return an optional `friction` array in its canonical result
-- (`[{ what, turnsLost?, surface, suggestedFix?, targetRepo? }]`, app/friction.ts
-- `AgentFrictionNote`). The engine propagates the result key verbatim as a process variable; the
-- poller captures each reported note — REDACTED with the collector's redactor — into this table with
-- its run linkage (owning process instance + the variable's scope, i.e. the element instance of the
-- completed job when local). `pr.friction-collect` then reads the rows in its window as the
-- `self_reported` signal kind.
--
-- EXPAND only. The runner wraps each file in its own transaction, so no BEGIN/COMMIT here.
CREATE TABLE IF NOT EXISTS friction_self_reports (
  id                   TEXT PRIMARY KEY,  -- sha256(variableKey, value)[:16] + ':' + note index — stable per report
  process_instance_key TEXT,              -- the run (canonical run identity `pi:<key>`)
  scope_key            TEXT,              -- the variable's scope (element instance of the job, or the instance)
  variable_key         TEXT NOT NULL,
  what                 TEXT NOT NULL,     -- redacted
  surface              TEXT NOT NULL,     -- one of FIX_SURFACES
  turns_lost           INTEGER,
  suggested_fix        TEXT,              -- redacted
  target_repo          TEXT,
  captured_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_friction_self_reports_captured ON friction_self_reports (captured_at);

ALTER TABLE friction_sweeps ADD COLUMN self_reported_count INTEGER NOT NULL DEFAULT 0;

-- Instances the capture saw ACTIVE on its last pass. When the global `friction` name page is full, the
-- capture probes these by key once more after they finish, so a report from an instance that completed
-- between passes is never lost behind the full history page (PR #1103 review).
CREATE TABLE IF NOT EXISTS friction_capture_watch (
  process_instance_key TEXT PRIMARY KEY
);
