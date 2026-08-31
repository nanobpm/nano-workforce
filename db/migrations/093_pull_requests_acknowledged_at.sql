-- Convergence (PRs): add the `acknowledged_at` dismissal stamp + backfill currently-terminal rows
-- (issue #641). This is the PR half of making all four "Active …" grids behave uniformly — a row STAYS
-- in Active until an operator dismisses it (acknowledge-to-dismiss), then drops to History — completing
-- the direction set in #637 by retiring the last two base-`status` allowlists (Convergence + Delivery
-- Graphs). The twin stamp already exists on `feature_runs` (073) and `plans` (074).
--
-- BACKFILL IS MANDATORY (the highest-risk item). Merlin carries hundreds of already-terminal PRs (~411
-- merged + 35 abandoned + 5 converged at authoring). Without the backfill, repointing the Active grids
-- at the derived `list_bucket` (094) — which folds an UNACKNOWLEDGED terminal PR into `active` — would
-- dump every one of those historical PRs into Active on the next boot. So we stamp `acknowledged_at` on
-- every CURRENTLY-terminal row here: they load in History from day one, and only PRs that reach a
-- terminal state AFTER this migration require an operator dismiss (their `acknowledged_at` stays NULL
-- until `acknowledgePr`). Stamp = COALESCE(merged_at, converged_at, updated_at): the best available
-- "when it settled" timestamp, and `updated_at` is NOT NULL so the stamp is never NULL for a matched
-- row.
--
-- Terminal set = the PR terminal tier {merged, converged, abandoned, closed, failed}
-- (app/pullRequestReadModel.ts `PR_TERMINAL_STATUSES`). Classified on the base `status` (the stored
-- ground truth at migration time; the reconciler's `derived_status` is a read-time projection). The
-- `acknowledged_at IS NULL` guard keeps the backfill idempotent — re-running never re-stamps a row an
-- operator later dismissed with a different timestamp.
--
-- The runner wraps each file in its own transaction — no BEGIN/COMMIT here. Numbered after 092.

ALTER TABLE pull_requests ADD COLUMN acknowledged_at TEXT;

UPDATE pull_requests
   SET acknowledged_at = COALESCE(merged_at, converged_at, updated_at)
 WHERE acknowledged_at IS NULL
   AND status IN ('merged', 'converged', 'abandoned', 'closed', 'failed');
