-- Delivery Graphs: add the `acknowledged_at` dismissal stamp + backfill currently-terminal runs (issue
-- #641). The Delivery-Graph half of the uniform acknowledge-to-dismiss behaviour (see 093 for the PR
-- half and the rationale): a terminal run STAYS in Active until an operator dismisses it, then drops to
-- History — retiring the `status IN ('awaiting-approval','running')` allowlist the pages filtered.
--
-- BACKFILL (mandatory, same risk as 093). Repointing the Active grids at the derived `list_bucket`
-- (096) folds an UNACKNOWLEDGED terminal run into `active`, so without a backfill every historical
-- terminal run would flood Active on boot. Stamp `acknowledged_at = updated_at` (a delivery-graph run
-- has no merged/converged timestamp; `updated_at` is its last-touch and is NOT NULL) on every currently-
-- terminal run so they load in History, and only runs that reach terminal AFTER this migration require
-- an operator dismiss.
--
-- Terminal set = {done, failed, abandoned} (app/deliveryGraphRun.ts `DELIVERY_GRAPH_TERMINAL_STATUSES`).
-- Classified on the base `status` (the stored ground truth at migration time). The `acknowledged_at IS
-- NULL` guard keeps the backfill idempotent.
--
-- The runner wraps each file in its own transaction — no BEGIN/COMMIT here. Numbered after 094.

ALTER TABLE delivery_graph_runs ADD COLUMN acknowledged_at TEXT;

UPDATE delivery_graph_runs
   SET acknowledged_at = updated_at
 WHERE acknowledged_at IS NULL
   AND status IN ('done', 'failed', 'abandoned');
