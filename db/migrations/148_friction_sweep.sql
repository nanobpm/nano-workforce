-- 148_friction_sweep.sql — issue #1073: the 12-hourly agent friction sweep
-- (resources/processes/friction-sweep.bpmn, app/friction.ts).
--
-- Three tables, all EXPAND (additive) — nothing is dropped or renamed:
--
--   friction_watermark — ONE row (`id = 'sweep'`) holding the exclusive lower bound of the next sweep
--     window. `pr.friction-collect` sweeps `(watermark, now]` and advances it with a compare-and-swap
--     (`UPDATE … WHERE watermark IS <old>`) in the SAME transaction that persists the window's digest +
--     signals, so a failed run never advances it (nothing lost) and a concurrent/duplicate firing that
--     loses the CAS persists nothing (nothing double-counted).
--
--   friction_sweeps — one row per sweep (keyed by the sweep's engine process-instance key): the
--     window, how many agent runs it swept, per-kind signal counts (flat INTEGER columns so the
--     `pages/friction.page.json` dataGrid renders the trend directly), the bounded redacted digest
--     handed to the analyst, and — once `pr.friction-file` ran — the created/updated issue URLs.
--
--   friction_signals — one row per extracted, REDACTED signal (excerpt + run link). The id is stable
--     per source record (`<kind>:<source key>[:<n>]`) so a job/incident the engine still reports on a
--     later sweep is not counted twice.
--
-- The runner wraps each file in its own transaction, so this file must NOT contain BEGIN/COMMIT.
CREATE TABLE IF NOT EXISTS friction_watermark (
  id         TEXT PRIMARY KEY,   -- always 'sweep'
  watermark  TEXT NOT NULL,      -- ISO ts: exclusive lower bound of the next window
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS friction_sweeps (
  sweep_key               TEXT PRIMARY KEY,  -- the friction-sweep process-instance key
  window_start            TEXT NOT NULL,     -- exclusive
  window_end              TEXT NOT NULL,     -- inclusive
  status                  TEXT NOT NULL,     -- collected | filed | noop
  runs_swept              INTEGER NOT NULL DEFAULT 0,
  signal_count            INTEGER NOT NULL DEFAULT 0,
  tool_error_count        INTEGER NOT NULL DEFAULT 0,
  permission_block_count  INTEGER NOT NULL DEFAULT 0,
  timeout_count           INTEGER NOT NULL DEFAULT 0,
  missing_generated_count INTEGER NOT NULL DEFAULT 0,
  repeated_command_count  INTEGER NOT NULL DEFAULT 0,
  failed_job_count        INTEGER NOT NULL DEFAULT 0,
  incident_count          INTEGER NOT NULL DEFAULT 0,
  escalation_count        INTEGER NOT NULL DEFAULT 0,
  tokens_total            INTEGER NOT NULL DEFAULT 0,
  digest                  TEXT,              -- the bounded, redacted digest (never a raw transcript)
  error                   TEXT,              -- why filing failed (status 'failed'); never overwrites digest
  created_issues          TEXT,              -- newline-separated issue URLs opened by pr.friction-file
  updated_issues          TEXT,              -- newline-separated issue URLs commented on by pr.friction-file
  created_count           INTEGER NOT NULL DEFAULT 0,
  updated_count           INTEGER NOT NULL DEFAULT 0,
  skipped_count           INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_friction_sweeps_window ON friction_sweeps (window_end);

CREATE TABLE IF NOT EXISTS friction_signals (
  id          TEXT PRIMARY KEY,   -- `<kind>:<source key>[:<n>]` — stable per source record
  sweep_key   TEXT NOT NULL,      -- the sweep that first recorded it
  kind        TEXT NOT NULL,      -- tool_error | permission_block | timeout | missing_generated | repeated_command | failed_job | incident | escalation
  run_key     TEXT NOT NULL,      -- agent-instance / job / incident / escalation key the signal came from
  run_url     TEXT,               -- link to the run's engine history (best-effort)
  fingerprint TEXT NOT NULL,      -- the normalised message the signal groups by
  excerpt     TEXT NOT NULL,      -- short, REDACTED excerpt around the signal
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_friction_signals_sweep ON friction_signals (sweep_key);
CREATE INDEX IF NOT EXISTS ix_friction_signals_kind ON friction_signals (kind, fingerprint);

-- The sweep's singleton lease (issue #1073 operator scope): exactly one friction-sweep instance may
-- sweep at a time. The first step of each instance takes it with an atomic conditional write; a new
-- firing that finds it held by a LIVE instance ends "skipped". It is released before the summary task
-- (an unread summary never blocks the next sweep) and on the error/SLA paths, and expires on its own
-- (`expires_at`) so a crashed or cancelled holder can't wedge the schedule.
CREATE TABLE IF NOT EXISTS friction_sweep_lock (
  id          TEXT PRIMARY KEY,   -- always 'sweep'
  holder      TEXT,               -- the holding friction-sweep processInstanceKey (NULL = free)
  expires_at  TEXT,               -- ISO instant the lease lapses (NULL = free)
  acquired_at TEXT,
  updated_at  TEXT NOT NULL
);

-- One row per issue a sweep opened or commented on, so pages/friction.page.json can render each issue
-- URL as a clickable grid link (detail fields render as plain text). Written by recordFiled.
CREATE TABLE IF NOT EXISTS friction_filings (
  sweep_key  TEXT NOT NULL,      -- the friction-sweep process-instance key
  action     TEXT NOT NULL,      -- opened | updated
  issue_url  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (sweep_key, action, issue_url)
);
