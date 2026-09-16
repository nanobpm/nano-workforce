-- 107_worker_harness_protocol.sql — issue #802: make stale worker harnesses observable and gateable.
--
-- A stale worker harness (a `c8ctl-nano` build predating the AgentInstance-minting + transcript-flush
-- + result-envelope path) silently services jobs and swallows every machine-readable artifact, so good
-- agent work is lost to the orchestration and every run it touches dead-ends at a human (#796/#801).
-- Job routing is blind to harness capability/version, so a stale harness wins job leases
-- indistinguishably from a healthy one.
--
-- The fix persists the protocol version a harness advertises at ENROLMENT — a WORKER ATTRIBUTE (ADR
-- 0056 §7 — capability gates enrolment, NEVER a routing token `network.role#seat`) — so the app can
-- (a) expose it in `getAgenticSupply` / the registry and (b) flag RED / refuse agent-job routing for
-- any worker below the minimum protocol. A MISSING version is treated as stale.
--
-- This mirrors `worker_durable_resume` (migration 052): one FK-free table keyed by the worker
-- instance (`register.instance` / the enrol `instance`). FK-free by design — enrolment is per-worker
-- and connection-agnostic, with no parent row to reference. EXPAND (additive) phase: one new table +
-- its index; nothing is dropped or renamed. Migration-prefix block 107–108 pre-assigned to this slice
-- (issue #802) off the origin/main high-water mark (104). The runner wraps each file in its own
-- transaction, so this file must NOT contain BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS worker_harness_protocol (
  instance          TEXT PRIMARY KEY,  -- the worker instance id (enrol `instance` / register.instance)
  -- The protocol version the harness advertised, or NULL when it advertised NONE. NULL is a first-class
  -- "advertised no version" marker — distinct in intent from an absent row (never enrolled here), but
  -- BOTH resolve to STALE at read time (absent version = stale). Recorded even on a downgrade so a
  -- harness that previously advertised a healthy protocol and later re-enrols WITHOUT one clears its
  -- stale-healthy value (mirrors the worker_durable_resume degrade-to-scratch semantics).
  harness_protocol  INTEGER,
  updated_at        TEXT NOT NULL
);

-- The gate scans for "which enrolled workers are below the minimum protocol?" — index the version so
-- that read is a covered scan rather than a table walk.
CREATE INDEX IF NOT EXISTS idx_worker_harness_protocol_version
  ON worker_harness_protocol(harness_protocol);
