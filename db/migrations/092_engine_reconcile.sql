-- Engine-reset reconciliation surface (issue #622).
--
-- When the Nano engine is reset, restored, or rolled to an incarnation whose key generator has
-- rewound (Magikcraft/nano-bpm#1065), `app.db` keeps projecting engine-backed inflight work that no
-- longer exists on the engine. These three sidecars give the app a first-class, idempotent,
-- provenance-stamped `reconcile` surface (app/reconcile.ts) that runs on startup and on demand:
--
--   • engine_incarnation  — the single-row last-seen engine incarnation/epoch id. The engine stamps
--     a monotonic incarnation id at boot (companion to the versioned snapshot envelope,
--     Magikcraft/nano-bpm#1068) and exposes it on `/v2/topology`. An epoch REGRESSION (the observed
--     epoch is lower than the recorded one) — or its absence where one was recorded — is the cheap,
--     robust "engine was reset/rewound → reconcile" signal, one check instead of N per-instance probes.
--   • reconcile_runs      — one row per reconcile pass: the observed vs recorded epoch, the outcome
--     reason, and how many rows were orphaned. The append-only audit of every convergence.
--   • reconcile_provenance— one row per orphaned transition: which engine-backed app row
--     (source_table, pk_value, its engine instance key) moved from which status to `orphaned`, why
--     (engine-reset/epoch-regression), the observed engine epoch, and the owning reconcile run id.
--     This is the provenance that makes each mutation legible and reversible instead of a silent drop.
--
-- These are app-owned bookkeeping surfaces; reconcile itself never mutates append-only audit or
-- already-terminal history — only NON-terminal, engine-backed rows (nano.app.json instanceTracking
-- bindings) whose status is still in the binding's activeStatuses set.

CREATE TABLE IF NOT EXISTS engine_incarnation (
  id INTEGER PRIMARY KEY CHECK (id = 1), -- single-row table: the app only tracks one engine
  epoch INTEGER,                          -- last-seen engine incarnation/epoch id (NULL until the engine exposes one)
  observed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reconcile_runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  observed_epoch INTEGER,   -- the engine epoch observed on this run (NULL when the engine exposes none)
  recorded_epoch INTEGER,   -- the previously-recorded epoch (NULL on the first ever run)
  reason TEXT NOT NULL,     -- 'epoch-regression' | 'seed-epoch' | 'no-op' | 'engine-unreachable'
  orphaned_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reconcile_provenance (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  source_table TEXT NOT NULL,  -- the engine-backed base table the orphaned row lives in
  pk_value TEXT NOT NULL,      -- the row's primary-key value
  key_value TEXT,              -- the engine instance key (keyField, e.g. process_key) the row projected
  from_status TEXT,            -- the non-terminal status the row carried before reconcile
  to_status TEXT NOT NULL,     -- always the defined 'orphaned' terminal
  reason TEXT NOT NULL,        -- 'engine-reset/epoch-regression'
  observed_epoch INTEGER,      -- the engine epoch observed when the row was orphaned
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_reconcile_provenance_run ON reconcile_provenance (run_id);
CREATE INDEX IF NOT EXISTS ix_reconcile_provenance_row ON reconcile_provenance (source_table, pk_value);
