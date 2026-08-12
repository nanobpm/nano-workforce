-- Operator visibility: at-a-glance wave X/N on the Epic Coordination view (issue #137).
--
-- `plan_tasks.wave` (005_plan_deps.sql) holds each task's 0-based wave, but the `plans`
-- row itself carries no progress summary — so the epics-index grid had no way to show how
-- far through its waves an epic is without joining/aggregating per row. Urban's datasource
-- cannot read a SQL VIEW (gateway.ts schema() whitelists only type='table'), so following
-- the codebase's existing convention (denormalised, worker-maintained pointers on `plans`
-- like open_task_id / open_plan_round / gate_wave) we project two flat columns:
--
--   • wave_count   — total number of waves (N). Written by `record-plan` alongside
--                    task_count, from the `waveCount` it already computes (app/waves.ts).
--   • current_wave — the 0-based index of the wave the fleet is ACTIVELY implementing
--                    (live). Initialised to 0 by `record-plan` at dispatch, advanced by
--                    `select-wave` at the start of each wave, and pinned to wave_count-1 on
--                    completion so a finished epic reads N/N. Display-only: it must never
--                    gate control flow (that stays driven by the currentWave/waveCount/
--                    gate_wave process state). NULL until the plan is dispatched with tasks.
--   • wave_label   — the human "X/N" progress string (1-based), e.g. "2/3". The dataGrid
--                    renders raw field values with no per-cell templating, so this pre-formats
--                    (current_wave+1)/wave_count for the epics-index at-a-glance column. Kept in
--                    lockstep with the two numeric columns by the same worker writes.
ALTER TABLE plans ADD COLUMN wave_count INTEGER;
ALTER TABLE plans ADD COLUMN current_wave INTEGER;
ALTER TABLE plans ADD COLUMN wave_label TEXT;
