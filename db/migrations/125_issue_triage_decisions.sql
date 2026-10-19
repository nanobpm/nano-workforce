-- 125_issue_triage_decisions.sql — issue #896: the durable ledger of the issue-triage loop.
--
-- One row per triaged issue (`triage_key` = `owner/repo#N`), upserted by the apply/review workers
-- (app/issueTriage.ts `recordTriageDecision`). It is both the reviewable record of every decision
-- (applied / escalated / skipped / rejected / failed, with the agent's confidence + rationale) and the
-- exclusion set the collect step consults so an issue is never re-triaged (except `failed`, retried).
-- `process_key` ties an `escalated` row to the triage instance parked on its `issue-triage-review` user
-- task, from which the Tasks inbox renders the batched review question.
--
-- Additive only (a new table). Numbered 125: above origin/main's highest committed prefix (124).
-- The runner wraps each file in its own transaction, so this file must NOT contain BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS issue_triage_decisions (
  triage_key   TEXT PRIMARY KEY,
  repo         TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  title        TEXT,
  url          TEXT,
  status       TEXT NOT NULL,
  labels       TEXT NOT NULL DEFAULT '[]',
  confidence   REAL,
  rationale    TEXT,
  duplicate_of TEXT,
  reason       TEXT,
  process_key  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS issue_triage_decisions_process_key ON issue_triage_decisions (process_key);
