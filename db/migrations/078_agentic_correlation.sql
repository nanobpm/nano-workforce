-- Durable per-job worker attribution + engine context (#485, provisioning #232).
--
-- The in-memory correlation registry (app/agentic/correlation.ts) is the live jobKey ⇄ worker join,
-- but it is RELEASED on job end / worker disconnect and is empty after a restart. So a COMPLETED
-- (past) session — what the cockpit "past sessions" / worker-history view reads — otherwise loses
-- which worker ran it (instance / identity / host) and its process-instance / plan context. The
-- package-mirrored transcript store (024_agentic_transcript.sql, byte-for-byte guarded) carries no
-- correlation columns, so this app-side table closes the gap WITHOUT touching that mirrored schema.
--
-- The relay slice records a row here at job-completion time; the transcript read path falls back to
-- it when the live registry has released the job. Advisory / read-only (ADR 0056) — it NEVER gates a
-- BPMN sequence flow.
--
-- Single source of truth: this DDL mirrors AGENTIC_CORRELATION_SCHEMA_SQL in
-- app/agentic/correlation-store.ts byte-for-byte; a drift-guard test (correlation-store.test.ts) pins
-- the two together.
CREATE TABLE IF NOT EXISTS agentic_correlation (
  job_key TEXT PRIMARY KEY,
  stream TEXT NOT NULL,
  instance TEXT NOT NULL,
  identity TEXT,
  host TEXT,
  process_instance_key TEXT,
  bpmn_process_id TEXT,
  element_id TEXT,
  plan_key TEXT,
  linked_at TEXT,
  completed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_agentic_correlation_instance ON agentic_correlation (instance);
CREATE INDEX IF NOT EXISTS ix_agentic_correlation_process_instance ON agentic_correlation (process_instance_key);
CREATE INDEX IF NOT EXISTS ix_agentic_correlation_plan ON agentic_correlation (plan_key);
