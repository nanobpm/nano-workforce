-- Plan-family GROUP-BY rollups, authored ONCE via Urban's ADR-0065 rollup primitive (`defineRollup`,
-- app/planRollups.ts, `@nanobpm/urban@0.82.0` / nano-ide#468) — issue #493 (the plan-family twin of
-- 076's feature read-model declare-once).
--
-- 059_plan_wave_summary.sql, 060_plan_wave_rollup.sql and 061_plan_delivery_rollup.sql hand-authored
-- the three plan-family aggregates — `plan_wave_counts` (per-(plan_key, wave) six-way task partition),
-- `plan_wave_progress` (the wave frontier `wave_count`/`current_wave`), and `plan_delivery_counts` (the
-- slice-PR landing counts) — as SQL VIEWs, AND folded the SAME counts a SECOND time in the runtime TS
-- (`deriveDelivery` folded the delivery counts; the poller reproduced the wave frontier). That is the
-- ADR-0065 drift surface #2 (each aggregate authored twice, kept in lockstep by hand-written parity
-- tests). This migration SUPERSEDES the three VIEW bodies with the VERBATIM DDL Urban compiles from the
-- ONE `defineRollup` declaration for each (app/planRollups.ts) — which ALSO drives the runtime TS
-- group-reduce (`reduce`, the sole engine behind `deriveDelivery` in app/delivery.ts). The two
-- lowerings fall out of the same closed GROUP-BY spec and cannot diverge; the drift guard
-- (app/planReadModel.test.ts) fails if this file stops matching the declaration, and
-- `assertRollupParity` proves the VIEW and TS reduce agree. 059/060/061 are MERGED, IMMUTABLE
-- migrations — never edited; this is a NEW migration superseding their VIEW bodies (the pattern by
-- which 081 superseded 076's feature VIEW).
--
-- SEMANTICS are unchanged from 059/060/061 (validated byte-identical over a random corpus): a task is
-- `merged` iff its PR reached `pull_requests.status = 'merged'`, otherwise it falls to its
-- `plan_tasks.status` bucket; the five named buckets stay DISJOINT and sum to `total`; the delivery
-- counts fold only tasks that OPENED a PR, and a dangling `pr_key` (NULL status) counts as in-flight so
-- a DB desync can never wrongly promote an epic to `landed`. Each rollup emits `CREATE VIEW <name> AS
-- SELECT … FROM … GROUP BY …` (aggregates aliased in the select-list) so the static pages↔schema
-- contract guard (scripts/pages-contract.test.ts) still reads each VIEW's output columns.
--
-- Layered in dependency order: `plan_wave_counts` first (the leaf GROUP BY over `plan_tasks` LEFT JOIN
-- `pull_requests`), then `plan_delivery_counts` (a sibling GROUP BY over the same join), then
-- `plan_wave_progress` (COMPOSED over `plan_wave_counts` — D1's composability). The retained
-- `plan_wave_summary` (059, the `bar` glyph) and `plan_wave_label` (060) VIEWs read the recreated
-- `plan_wave_counts`/`plan_wave_progress` unchanged. A merged VIEW is not editable in place, so each is
-- DROP+CREATE; nothing structural changes, so every dependent VIEW and page binding stays valid.
--
-- Forward-only VIEW redefinition (DROP then CREATE). The runner wraps each file in its own transaction,
-- so this file must NOT contain BEGIN/COMMIT. Numbered after 081.

DROP VIEW IF EXISTS plan_wave_counts;

CREATE VIEW IF NOT EXISTS "plan_wave_counts" AS
SELECT
  "t"."plan_key" AS "plan_key",
  "t"."wave" AS "wave",
  SUM(CASE WHEN COALESCE(((NOT COALESCE(COALESCE(("p"."status" = 'merged'), 0), 0)) AND COALESCE(("t"."status" = 'blocked'), 0)), 0) THEN 1 ELSE 0 END) AS "blocked",
  SUM(CASE WHEN COALESCE(((NOT COALESCE(COALESCE(("p"."status" = 'merged'), 0), 0)) AND COALESCE(("t"."status" = 'escalated'), 0)), 0) THEN 1 ELSE 0 END) AS "escalated",
  SUM(CASE WHEN COALESCE(((NOT COALESCE(COALESCE(("p"."status" = 'merged'), 0), 0)) AND (NOT COALESCE(COALESCE((COALESCE(("t"."status" = 'skipped'), 0) OR COALESCE(("t"."status" = 'blocked'), 0) OR COALESCE(("t"."status" = 'escalated'), 0)), 0), 0))), 0) THEN 1 ELSE 0 END) AS "in_flight",
  SUM(CASE WHEN COALESCE(("p"."status" = 'merged'), 0) THEN 1 ELSE 0 END) AS "merged",
  SUM(CASE WHEN COALESCE(((NOT COALESCE(COALESCE(("p"."status" = 'merged'), 0), 0)) AND COALESCE(("t"."status" = 'skipped'), 0)), 0) THEN 1 ELSE 0 END) AS "skipped",
  COUNT(*) AS "total"
FROM "plan_tasks" "t" LEFT JOIN "pull_requests" "p" ON "t"."pr_key" = "p"."pr_key"
WHERE (NOT COALESCE(("t"."wave" IS NULL), 0))
GROUP BY "t"."plan_key", "t"."wave";

DROP VIEW IF EXISTS plan_delivery_counts;

CREATE VIEW IF NOT EXISTS "plan_delivery_counts" AS
SELECT
  "t"."plan_key" AS "plan_key",
  SUM(CASE WHEN COALESCE(((NOT COALESCE(("t"."pr_key" IS NULL), 0)) AND (NOT COALESCE(COALESCE((COALESCE(("p"."status" = 'converged'), 0) OR COALESCE(("p"."status" = 'merged'), 0) OR COALESCE(("p"."status" = 'abandoned'), 0)), 0), 0))), 0) THEN 1 ELSE 0 END) AS "prs_in_flight",
  SUM(CASE WHEN COALESCE(((NOT COALESCE(("t"."pr_key" IS NULL), 0)) AND COALESCE(("p"."status" = 'merged'), 0)), 0) THEN 1 ELSE 0 END) AS "prs_merged",
  COUNT("t"."pr_key") AS "prs_opened"
FROM "plan_tasks" "t" LEFT JOIN "pull_requests" "p" ON "t"."pr_key" = "p"."pr_key"
GROUP BY "t"."plan_key";

DROP VIEW IF EXISTS plan_wave_progress;

CREATE VIEW IF NOT EXISTS "plan_wave_progress" AS
SELECT
  "__urban_rollup_src"."plan_key" AS "plan_key",
  COALESCE(MIN(CASE WHEN COALESCE(("__urban_rollup_src"."in_flight" > 0), 0) THEN "__urban_rollup_src"."wave" END), MAX("__urban_rollup_src"."wave")) AS "current_wave",
  (MAX("__urban_rollup_src"."wave") + 1) AS "wave_count"
FROM "plan_wave_counts" "__urban_rollup_src"
GROUP BY "__urban_rollup_src"."plan_key";
