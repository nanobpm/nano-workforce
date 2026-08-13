-- Agentic visibility plane — presence & registry (ADR 0056, H1 / #144).
--
-- The durable supply mirror behind the agentic channel's presence family. A worker that opens the
-- channel and sends `register` lands one row here (keyed by its instance id) carrying its declared
-- enrolment capability (cognition/weight/family/host — an ENROLMENT attribute, NEVER a routing
-- token), the connection it registered on, and its own heartbeat-refreshed `last_seen` liveness.
-- Heartbeats refresh `last_seen`; `deregister`, an observed disconnect, or the presence-TTL sweep
-- remove the row. This is the read-only supply feed the enrolment epic (#152) reads — it is advisory
-- and NEVER gates a BPMN sequence flow.
--
-- The very same DDL is the single source of truth the runtime's `PresenceStore` applies through
-- `ensureSchema()` (@nanobpm/agentic/presence, `PRESENCE_SCHEMA_SQL`). Keeping the two application
-- paths (this boot migration and the store's guard) statement-for-statement identical is what stops
-- a production/boot schema drift. Forward-only and additive: `CREATE ... IF NOT EXISTS` only.
--
-- This is the reserved prefix H0 pre-allocated for H1 (023) so parallel wave-1 siblings never
-- independently grab "the next" migration number (H3 → 024_agentic_transcript, H4 → 025_agentic_blackboard).
CREATE TABLE IF NOT EXISTS agentic_presence (
  instance      TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  identity      TEXT NOT NULL,
  cognition     TEXT,
  weight        REAL,
  family        TEXT,
  host          TEXT,
  registered_at TEXT NOT NULL,
  last_seen     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agentic_presence_last_seen ON agentic_presence (last_seen);
CREATE INDEX IF NOT EXISTS idx_agentic_presence_connection ON agentic_presence (connection_id);
