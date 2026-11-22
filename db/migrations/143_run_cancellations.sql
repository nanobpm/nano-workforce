-- Operator-cancel provenance for every tracked run kind (issue #994).
--
-- An operator cancel through the app's cancel door (`/actions/cancel`, `/actions/cancel-pr`) records
-- WHO cancelled, WHEN and WHY here, keyed by the cancelled engine process-instance key. The read models
-- fold it over the canonical terminated edge (`abandoned`, app/runTerminal.ts) to report a distinct,
-- neutral `cancelled` terminal status instead of `failed`/`abandoned`. One table for every kind
-- (feature / convergence loop / delivery graph / plan), so no kind owns its own cancel mapping.
-- Additive only. The runner wraps each file in its own transaction (no BEGIN/COMMIT here).

CREATE TABLE IF NOT EXISTS run_cancellations (
  process_key   TEXT PRIMARY KEY,
  run_table     TEXT,
  cancelled_by  TEXT NOT NULL,
  cancel_reason TEXT,
  cancelled_at  TEXT NOT NULL
);
