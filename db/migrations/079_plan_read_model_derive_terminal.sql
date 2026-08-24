-- Fold the ADR-0065 DERIVED terminal edge into the epic read model (issue #503 — the plans row of the
-- "migrate remaining terminal-edge readers to derived_status" class).
--
-- Since ADR-0065 (`@nanobpm/urban@0.81.0`) the `instanceTracking` reconciler is a SOURCE, not a writer:
-- on cancel/terminate it feeds urban's instance projection and the terminal edge (`onTerminated →
-- abandoned`) is RECOMPUTED ON READ as `plans__tracking.derived_status` — it NO LONGER writes
-- `abandoned` onto the base `plans.status` column. `plans` had NO derived reader, so a terminated epic's
-- base row stayed frozen at `planning`/`dispatched` and 074's `plan_read_model` bucketed it ACTIVE
-- forever (a terminated epic rendered active on the epic index/detail).
--
-- 074_plan_read_model_derive_bucket.sql made `plan_read_model` the composite VIEW the epic pages bind
-- and DERIVED `list_bucket`/`ack_open` from the base `plans.status` (+ `acknowledged_at` + the derived
-- `plan_delivery.delivery` signal). This migration redefines `plan_read_model` (same name, so no page
-- repoint is needed) to read the EFFECTIVE status off the auto-provisioned `plans__tracking` derived
-- VIEW instead of the frozen base column: the projected `status` and the bucket/ack derivations now
-- fold in the reconciler's terminal edge, so a cancelled/terminated epic drops out of Active with no
-- worker write and no poller pass.
--
-- `plans__tracking` is the managed VIEW urban provisions at mount (`<table>__tracking`, ADR-0065),
-- re-exporting `plans.*` plus a `derived_status` column that is `abandoned` on a terminated instance and
-- the base `plans.status` otherwise. SQLite does not validate a view body at CREATE time, so this
-- migration (which runs before the runtime mount that provisions `plans__tracking`) is created fine and
-- resolves once the managed VIEW exists. The `COALESCE(t.derived_status, pl.status)` fallback degrades to
-- the previous base-column behaviour only for an unexpected NULL `derived_status` or a missing joined row
-- (the LEFT JOIN yielding no `t` row) — it does NOT protect against the `plans__tracking` VIEW being
-- absent, which would fail this VIEW's query at read time.
--
-- A merged view is not editable in place (that would edit a shipped migration), so this DROPs and
-- re-CREATEs it. `plan_read_model` is a leaf — no other view builds on it — so the DROP is safe. Its
-- output column set is UNCHANGED (only the SOURCE of `status`/`list_bucket`/`ack_open` moved from the
-- base column to the derived VIEW), so the pages↔schema contract guard and every page binding stay
-- valid.
--
-- Forward-only. NO BEGIN/COMMIT — the runner wraps each file in its own transaction. Numbered after 078.

DROP VIEW plan_read_model;

CREATE VIEW plan_read_model AS
SELECT
  pl.plan_key AS plan_key,
  pl.repo AS repo,
  pl.issue_number AS issue_number,
  pl.issue_url AS issue_url,
  pl.title AS title,
  COALESCE(t.derived_status, pl.status) AS status,
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
    WHEN COALESCE(t.derived_status, pl.status) IN ('planning', 'dispatched') THEN 'active'
    WHEN COALESCE(t.derived_status, pl.status) = 'done' AND d.delivery = 'converging' THEN 'active'
    WHEN COALESCE(t.derived_status, pl.status) = 'done' AND pl.acknowledged_at IS NULL THEN 'active'
    WHEN COALESCE(t.derived_status, pl.status) = 'done' THEN 'history'
    ELSE 'history'
  END) AS list_bucket,
  (CASE
    WHEN COALESCE(t.derived_status, pl.status) = 'done' AND d.delivery IS NOT 'converging' AND pl.acknowledged_at IS NULL THEN 1
    ELSE 0
  END) AS ack_open,
  wl.wave_count AS wave_count,
  wl.current_wave AS current_wave,
  wl.wave_label AS wave_label,
  d.delivery AS delivery,
  d.delivery_label AS delivery_label
FROM plans pl
LEFT JOIN plans__tracking t ON t.plan_key = pl.plan_key
LEFT JOIN plan_wave_label wl ON wl.plan_key = pl.plan_key
LEFT JOIN plan_delivery d ON d.plan_key = pl.plan_key;
