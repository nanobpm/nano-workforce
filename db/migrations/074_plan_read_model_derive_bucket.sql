-- Derive the epic Active/History bucket in the read-model VIEW instead of at write time (issue #439 —
-- the status-driven follow-up to epic #412).
--
-- 044_plan_list_bucket.sql denormalised `plans.list_bucket` / `plans.ack_open` onto the row, projected
-- at WRITE TIME by the `plans()` gateway (app/plan.ts) from the pure `deriveEpicBucket` /
-- `epicIsAcknowledgeable` (app/delivery.ts), with a read-time `pollPlanBucket` pass (app/service.ts)
-- supplying the delivery-aware correction the delivery-free gateway could not. As with feature_runs
-- (073), that write path is bypassed by the framework `instanceTracking` reconciler, which writes
-- `plans.status` through the RAW datasource (`{status:"abandoned"}` on a terminated instance) —
-- leaving `list_bucket`/`ack_open` frozen at their pre-terminal values, so a cancelled epic drifts the
-- same way a cancelled feature run does.
--
-- 061_plan_delivery_rollup.sql already made `plan_read_model` the composite VIEW the operator pages
-- bind, but it still READ `pl.list_bucket` / `pl.ack_open` straight off the denormalised columns. This
-- migration redefines `plan_read_model` (same name, so no page repoint is needed) to DERIVE both from
-- the base inputs — `status`, `acknowledged_at`, and the already-derived `plan_delivery.delivery`
-- signal — removing the last read of the stored columns. The bucket is now a pure function with no
-- write-path: there is nothing for the reconciler (or `pollPlanBucket`, which this retires) to leave
-- stale. The CASE expressions MIRROR `deriveEpicBucket` / `epicIsAcknowledgeable` exactly, cross-checked
-- against those pure functions in app/plansReadModel.test.ts.
--
-- Deriving from the REAL delivery signal is strictly MORE correct than the old write-time projection,
-- which had to assume `delivery = null` (it could not see the read-time signal) and relied on
-- `pollPlanBucket` to clear `ack_open` while a `done` epic was still converging. The view sees the live
-- `plan_delivery.delivery`, so a still-converging epic never offers Dismiss (`ack_open = 0`) without a
-- poller pass.
--
-- A merged view is not editable in place (that would edit a shipped migration), so this DROPs and
-- re-CREATEs it. `plan_read_model` is a leaf — no other view builds on it — so the DROP is safe. Its
-- output column set is UNCHANGED (list_bucket/ack_open are still projected, only their derivation
-- changed), so the pages↔schema contract guard and every page binding stay valid.
--
-- Forward-only. NO BEGIN/COMMIT — the runner wraps each file in its own transaction. Numbered after
-- 073.

DROP VIEW plan_read_model;

CREATE VIEW plan_read_model AS
SELECT
  pl.plan_key AS plan_key,
  pl.repo AS repo,
  pl.issue_number AS issue_number,
  pl.issue_url AS issue_url,
  pl.title AS title,
  pl.status AS status,
  pl.task_count AS task_count,
  pl.process_key AS process_key,
  pl.outcome AS outcome,
  pl.updated_at AS updated_at,
  pl.epic_phase AS epic_phase,
  pl.base_branch AS base_branch,
  pl.wait_gate_label AS wait_gate_label,
  pl.bound_artifacts AS bound_artifacts,
  pl.promotion_pr AS promotion_pr,
  pl.promotion_state AS promotion_state,
  (CASE
    WHEN pl.status IN ('planning', 'dispatched') THEN 'active'
    WHEN pl.status = 'done' AND d.delivery = 'converging' THEN 'active'
    WHEN pl.status = 'done' AND pl.acknowledged_at IS NULL THEN 'active'
    WHEN pl.status = 'done' THEN 'history'
    ELSE 'history'
  END) AS list_bucket,
  (CASE
    WHEN pl.status = 'done' AND d.delivery IS NOT 'converging' AND pl.acknowledged_at IS NULL THEN 1
    ELSE 0
  END) AS ack_open,
  wl.wave_count AS wave_count,
  wl.current_wave AS current_wave,
  wl.wave_label AS wave_label,
  d.delivery AS delivery,
  d.delivery_label AS delivery_label
FROM plans pl
LEFT JOIN plan_wave_label wl ON wl.plan_key = pl.plan_key
LEFT JOIN plan_delivery d ON d.plan_key = pl.plan_key;
