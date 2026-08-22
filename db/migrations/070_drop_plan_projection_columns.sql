-- Contract phase for the worker-maintained `plans` projection columns (epic #412: retire
-- worker-maintained denormalised projections in favour of SQL VIEWs).
--
-- Wave-0 of this epic re-expressed every one of these denormalised `plans` columns as a DERIVED SQL
-- VIEW computed from the SAME pure helpers that used to feed the write-path, and repointed every
-- operator page onto those views:
--   • `wave_count` / `current_wave` / `wave_label` (022_plan_wave_progress.sql) → `plan_wave_progress`
--     / `plan_wave_label` / `plan_read_model` (060/061), derived from the levelized `plan_tasks`.
--   • `delivery` / `delivery_label` (029_plan_delivery.sql) → `plan_delivery` / `plan_read_model`
--     (061), derived via the pure `deriveDelivery`/`TERMINAL_STATUSES` (app/delivery.ts) by joining
--     each slice `plan_tasks.pr_key` → `pull_requests.status`.
--
-- This wave-1 cleanup deletes the now-dead write-paths (the `record-plan`/`record-wave`/`select-wave`
-- worker writes and the `pollDelivery` poller) and repoints the last internal readers onto read-time
-- derivation (`pollPlanBucket`/`pollPromotion` recompute `delivery` via `deriveDelivery`;
-- `pollWaitGate` derives "has the epic fanned out?" from `plan_tasks`). With no remaining writer or
-- reader, these five columns are dead schema — a drift surface with no source of truth behind them —
-- so drop them. The `plan_read_model` / `plan_wave_label` / `plan_delivery` VIEWs DERIVE their
-- wave/delivery columns from the join surfaces, never from these `plans` columns, so the pages the
-- views back are unaffected.
--
-- Forward-only contract migration numbered in this task's disjoint 070-079 block (029/022 are
-- forward-only and immutable, so this is the standard expand→contract follow-up, not an edit to
-- them). All five columns were nullable with no default and have no remaining writer or reader, and
-- no index references them, so a plain `ALTER TABLE … DROP COLUMN` suffices. The runner wraps each
-- file in its own transaction, so this file must NOT contain BEGIN/COMMIT.
ALTER TABLE plans DROP COLUMN wave_count;
ALTER TABLE plans DROP COLUMN current_wave;
ALTER TABLE plans DROP COLUMN wave_label;
ALTER TABLE plans DROP COLUMN delivery;
ALTER TABLE plans DROP COLUMN delivery_label;
