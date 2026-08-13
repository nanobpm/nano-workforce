-- Generalize the advisory blackboard onto the agentic channel's blackboard family (ADR 0056, H4 /
-- #147). Reserved prefix `025` was pre-allocated by H0 (#143) so no two sibling slices collide on
-- "the next" number.
--
-- The per-plan advisory blackboard (issues #51 / #49 D4, migration 009's `plan_blackboard`) is
-- promoted to `@nanobpm/agentic/blackboard`'s first-class, capability-scoped `agentic_blackboard`
-- store — the SAME store the new agentic-channel `blackboard` family serves, over the SAME app
-- SQLite DataLayer. The HTTP hook (`/app/api/hooks/blackboard`) and the channel now read/write one
-- canonical table (no drift surface), scoped by the plan key exactly as before.
--
-- Forward-only and additive (expand phase): a new table + indexes, then a one-shot backfill of the
-- existing `plan_blackboard` rows (`plan_key` → `scope`) so in-flight plans keep their coordination
-- history unaffected. The old `plan_blackboard` table is intentionally NOT dropped here — dropping a
-- table a release just stopped reading is a separate, later contract phase.
--
-- The CREATE statements below are the canonical `BLACKBOARD_SCHEMA_SQL` verbatim (the same DDL the
-- store's `ensureSchema()` and the agentic-channel family apply), so the migration path and the
-- `CREATE TABLE IF NOT EXISTS` path can never drift. `app/blackboard.schema.test.ts` guards this.
CREATE TABLE IF NOT EXISTS agentic_blackboard (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT NOT NULL,
  author_task TEXT NOT NULL DEFAULT 'system',
  kind        TEXT NOT NULL DEFAULT 'note',
  files       TEXT,
  body        TEXT NOT NULL,
  wave        INTEGER,
  dedupe_key  TEXT,
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_agentic_blackboard_dedupe ON agentic_blackboard (scope, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agentic_blackboard_scope ON agentic_blackboard (scope, id);

-- Backfill: carry every existing per-plan entry over under scope = plan_key, in write order (id asc)
-- so the new autoincrement ids stay monotonic in the original write order. The old table's UNIQUE
-- (plan_key, dedupe_key) invariant maps 1:1 onto the new (scope, dedupe_key) index, so no collision.
INSERT INTO agentic_blackboard (scope, author_task, kind, files, body, wave, dedupe_key, created_at)
SELECT plan_key, author_task, kind, files, body, wave, dedupe_key, created_at
FROM plan_blackboard
ORDER BY id;
