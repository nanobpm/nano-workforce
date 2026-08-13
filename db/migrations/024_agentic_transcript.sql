-- Agentic visibility plane (ADR 0056, epic #142) — H3 relay transcript store (#146).
--
-- The relay family (app/agentic/families/relay.family.ts) mounts @nanobpm/agentic/relay (a bounded
-- replay ring + three-lane QoS scheduler + incarnation fence) on the app-tier agentic channel and
-- persists terminal transcripts through @nanobpm/agentic/transcript with retention-by-lifecycle:
--
--   • ephemeral streams  → the relay ring is flushed to a durable transcript on job completion
--                          (and the stream marked `completed`, then retired by a retention sweep);
--   • long-lived streams → chunks are retained/checkpointed so a reconnecting consumer can resume
--                          from any offset (reattach), bounded by a rolling offset window.
--
-- This DDL is the forward-only, additive boot migration the DataLayer runner applies from
-- nano.app.json (`data.sources.app.migrations`). It is a byte-for-byte mirror of the package's
-- canonical `TRANSCRIPT_SCHEMA_SQL` (@nanobpm/agentic/transcript `schema.ts`), which the store also
-- applies via `ensureSchema()`. The two application paths are kept from drifting by the drift-guard
-- test `app/agentic/families/relay.family.test.ts` — divergence is a red test, not a silent boot vs.
-- store mismatch. Additive only (CREATE ... IF NOT EXISTS): it adds no column to an existing table
-- and drops nothing, so it is safe to apply forward over any earlier schema.
--
-- H0 (#143) pre-allocated this exact prefix (024) for H3 so no two sibling slices independently grab
-- "the next" number (H1=023_agentic_presence, H4=025_agentic_blackboard). `chunk_offset` (not
-- `offset`) is deliberate: OFFSET is a SQLite keyword, so the column avoids quoting in every query.
--
-- Invariants (ADR 0056): app-tier only, never the engine; the Camunda-8 job protocol (worker⇄engine)
-- is untouched — the agentic channel is the only new conversation; advisory semantics preserved (the
-- transcript never hard-locks or gates a BPMN sequence flow).
CREATE TABLE IF NOT EXISTS agentic_transcript_stream (
  stream        TEXT PRIMARY KEY,
  lifecycle     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',
  created_at    TEXT NOT NULL,
  completed_at  TEXT,
  first_offset  INTEGER,
  next_offset   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agentic_transcript_chunk (
  stream        TEXT NOT NULL,
  chunk_offset  INTEGER NOT NULL,
  chunk         TEXT NOT NULL,
  appended_at   TEXT NOT NULL,
  PRIMARY KEY (stream, chunk_offset)
);
CREATE INDEX IF NOT EXISTS idx_agentic_transcript_stream_retention ON agentic_transcript_stream (lifecycle, status, completed_at);
