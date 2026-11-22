-- Backfill the epic aggregate's `auto_merge` for plan rows that predate the column (issue #1007,
-- PR #1010 review, round 3). Migration 140 added `plans.auto_merge INTEGER NOT NULL DEFAULT 1`, so
-- every existing plan row now reads 1 — but 141 only re-created the `plans` → `delivery_units`
-- sync triggers, which fire on INSERT/UPDATE: an untouched pre-140 plan's aggregate row still
-- carries `auto_merge = NULL`, so `plans__units` disagrees with `plans` until some unrelated plan
-- update happens to re-fire the trigger. Mirror the canonical plan rows into the aggregate once,
-- keyed on the same unit identity the triggers use (`'epic:' || plan_key`). Only the `epic` kind's
-- `auto_merge` is touched; every other column/kind is left exactly as the triggers project it.
UPDATE delivery_units
SET auto_merge = (SELECT p.auto_merge FROM plans p WHERE 'epic:' || p.plan_key = delivery_units.unit_id)
WHERE kind = 'epic'
  AND EXISTS (SELECT 1 FROM plans p WHERE 'epic:' || p.plan_key = delivery_units.unit_id)
  AND auto_merge IS NOT (SELECT p.auto_merge FROM plans p WHERE 'epic:' || p.plan_key = delivery_units.unit_id);
