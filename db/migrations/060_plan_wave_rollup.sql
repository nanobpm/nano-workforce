-- Wave-progress read model as a derived VIEW (epic #412 — retire worker-maintained projections).
--
-- 022_plan_wave_progress.sql denormalised `plans.wave_count` / `plans.current_wave` /
-- `plans.wave_label` — a per-epic "wave X/N" at-a-glance projection — onto the `plans` row, written
-- by the wave workers (`record-plan`, `select-wave`, `record-wave`). Its comment cites the sole
-- reason it was a worker-maintained table rather than a VIEW: "Urban's datasource cannot read a SQL
-- VIEW". That constraint is gone (nano-ide#424: `gateway.schema()` now introspects
-- `type IN ('table','view')`), so — exactly like 059 did for the wave-summary rollup — this expresses
-- the same projection as a DERIVED view: a single source of truth with NO write-path and no drift
-- from `plan_tasks`.
--
-- Reuses 059's `plan_wave_counts` (one row per (plan_key, wave), with the six-way task partition,
-- including `in_flight`) so the frontier can be derived purely, layered so each view stays a plain
-- `CREATE VIEW <name> AS SELECT … FROM …` (no CTE / no select-list subquery) — which keeps them
-- parseable by the static pages↔schema contract guard (scripts/pages-contract.test.ts).
--
--   • plan_wave_progress — one row per plan_key with the two numeric projections:
--       - wave_count   = MAX(wave)+1 (the levelizer emits contiguous waves 0..N-1, so this equals
--                        `app/waves.ts` `waveCount`). A plan with no LEVELIZED tasks contributes no
--                        `plan_wave_counts` row, so it is absent here and reads NULL through the
--                        downstream LEFT JOIN — matching the workers, which leave a taskless plan's
--                        wave columns NULL.
--       - current_wave = the live FRONTIER, derived (not process-state-tracked): the lowest wave
--                        that still has an `in_flight` task (the wave the fleet is actively
--                        implementing / the wave the merge-barrier is gating), else — once every
--                        wave has settled (in_flight = 0 everywhere) — pinned to the last index
--                        MAX(wave). This reproduces the workers' projection: `record-plan` starts it
--                        at 0 (wave 0 is in flight), `record-wave`/`select-wave` advance it to the
--                        next gating wave as each wave's PRs merge, and it pins to wave_count-1 on
--                        completion (a finished epic reads N/N).
--   • plan_wave_label    — the same two numbers PLUS `wave_label`, the PRE-FORMATTED 1-based "X/N"
--                          display string (`(current_wave+1)/wave_count`) the epics-index and epic
--                          banner render, because the dataGrid has no per-cell templating.
--
-- Forward-only, additive (a new read model; no schema change to any base table). The runner wraps
-- each file in its own transaction, so this file must NOT contain BEGIN/COMMIT.

CREATE VIEW plan_wave_progress AS
SELECT
  c.plan_key AS plan_key,
  MAX(c.wave) + 1 AS wave_count,
  COALESCE(MIN(CASE WHEN c.in_flight > 0 THEN c.wave END), MAX(c.wave)) AS current_wave
FROM plan_wave_counts c
GROUP BY c.plan_key;

CREATE VIEW plan_wave_label AS
SELECT
  w.plan_key AS plan_key,
  w.wave_count AS wave_count,
  w.current_wave AS current_wave,
  (w.current_wave + 1) || '/' || w.wave_count AS wave_label
FROM plan_wave_progress w;
