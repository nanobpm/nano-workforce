-- Backfill for issue #959: merged PRs whose run was terminated afterwards showed as "abandoned".
--
-- ROOT CAUSE. `pull_requests__tracking.derived_status` mapped ANY terminated run to `abandoned`
-- without consulting the PR's merge state. Of the 24 top-level runs terminated in November, 23
-- belong to PRs that MERGED on GitHub — an operator cancelled a redundant post-merge loop, an
-- out-of-band merge (Mergify / a manual click) was reconciled, or a restart/upgrade cleaned up. Every
-- one read "abandoned", which made the status untrustworthy and skewed retro/conformance stats
-- (`LANDED_PR_STATUSES` excludes `abandoned`, so merged PRs didn't count as landed).
--
-- THE FIX is the merge-aware derivation (app/prTrackingReadModel.ts): a landed PR now reads `merged`
-- regardless of how its instance ended, keyed off the base row's `merged_at`. That derivation is
-- merge-aware ONLY when `merged_at` is set — but several out-of-band/reconciled merges terminated the
-- loop BEFORE `pr.mark-merged` (or the review-wait retire) could stamp `merged_at`, leaving the base
-- row frozen at its in-flight transient (`converging`/`waiting_merge`/…) with `merged_at` NULL. For
-- those rows the derivation still has no merge signal, so they would keep reading `abandoned`.
--
-- This migration re-derives the existing rows so the 23 show as `merged`: any `pull_requests` row
-- that has a `merged` outcome in its `merges` audit trail but whose base `status` is not already
-- `merged` (and that has no `merged_at` yet) is stamped `status='merged'` + `merged_at`. The audit
-- trail (`merges.outcome='merged'`) is the canonical record that the PR landed — written by
-- `pr.mark-merged`, the merge worker's already-merged short-circuit, and the out-of-band retire path.
-- With the base row settled to `merged`, the derivation reads `merged` whether or not the instance
-- was later terminated (the terminated edge is gated on `merged_at IS NULL`).
--
-- Idempotent and additive-only: it touches only rows with a recorded `merged` audit outcome that are
-- not already settled `merged`, and never overwrites an existing `merged_at`. `merged_at` is stamped
-- from the earliest `merged` audit row (`MIN(m.at)`), falling back to the current timestamp when that
-- is somehow NULL. Safe to re-run.
UPDATE pull_requests
SET status = 'merged',
    merged_at = COALESCE(
      merged_at,
      (SELECT MIN(m.at) FROM merges m WHERE m.pr_key = pull_requests.pr_key AND m.outcome = 'merged'),
      datetime('now')
    ),
    updated_at = datetime('now')
WHERE status <> 'merged'
  AND EXISTS (
    SELECT 1 FROM merges m WHERE m.pr_key = pull_requests.pr_key AND m.outcome = 'merged'
  );
