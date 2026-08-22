-- Epic-detail wave visualization + task→representation links (issue #411).
--
-- The Epic detail page (pages/epic-detail.page.json) had no glanceable per-wave progress and no
-- click-through from an in-flight task to the thing that represents it (its PR / process instance).
-- Both are pure ROLLUPS of data that already exists — `plan_tasks` (the slices + their wave) joined
-- to `pull_requests` (each slice's PR url + engine `process_key`) — so per AGENTS.md "Derivation over
-- duplication / no drift surfaces" they are DERIVED, not denormalised onto a worker-written table.
--
-- Historically the codebase reached for a denormalised flat table here (see 022_plan_wave_progress,
-- 029_plan_delivery, 051_merges_per_day) purely because Urban's datasource could not read a SQL
-- VIEW. That constraint is gone (nano-ide#424: `gateway.schema()` now introspects
-- `type IN ('table','view')` and tags a view read-only), so these are VIEWs — a single source of
-- truth with NO write-path and no possibility of drift from `plan_tasks`.
--
-- Three views, layered so each is a plain `CREATE VIEW <name> AS SELECT … FROM …` (no CTE / no
-- select-list subquery) — which keeps them parseable by the static pages↔schema contract guard
-- (scripts/pages-contract.test.ts) that introspects the migrations to whitelist page columns:
--
--   • plan_wave_tasks   — per-task rows (every `plan_tasks` column) PLUS the link targets the
--                         wave-state grid needs to reach a task's representation: `pr_url`
--                         (pull_requests.url — the GitHub PR) and `process_key`
--                         (pull_requests.process_key — the engine instance, for the processExplorer
--                         link, exactly as the Plan grid links its own `process_key`).
--   • plan_wave_counts  — one row per (plan_key, wave) with the six-way task partition
--                         (total / merged / in_flight / blocked / escalated / skipped). A task is
--                         `merged` iff its PR reached `pull_requests.status = 'merged'` (the same
--                         merged predicate app/delivery.ts derives the epic rollup from); otherwise
--                         it falls to its `plan_tasks.status` bucket, and everything else
--                         (pending/opened/waiting-for-lane/abandoned) is `in_flight`. The CASE
--                         priority makes the five named buckets DISJOINT so they always sum to
--                         `total` — which is what lets the bar below use `total` as its width.
--   • plan_wave_summary — the same counts PLUS `bar`, a PRE-FORMATTED progress string
--                         (e.g. "▓▓▓░░ 3/5 merged · 1 in-flight · 1 blocked"). It is pre-formatted
--                         because the dataGrid renderer has no per-cell templating — a bar has to be
--                         a ready-to-show string. `▓` = merged, `░` = not-yet-merged; the block run
--                         is built with SQLite string funcs (`hex(zeroblob(n))` → n '0' chars →
--                         `replace` to the glyph), and only non-zero categories are named in the
--                         suffix.
--
-- Forward-only, additive (a new read model, no schema change to any base table). The runner wraps
-- each file in its own transaction, so this file must NOT contain BEGIN/COMMIT. Numbered after the
-- current highest prefix (058).

CREATE VIEW plan_wave_tasks AS
SELECT
  t.id AS id,
  t.plan_key AS plan_key,
  t.task_index AS task_index,
  t.task_id AS task_id,
  t.title AS title,
  t.prompt AS prompt,
  t.status AS status,
  t.pr_key AS pr_key,
  t.summary AS summary,
  t.created_at AS created_at,
  t.updated_at AS updated_at,
  t.wave AS wave,
  t.open_question AS open_question,
  t.answer AS answer,
  t.draft_pr_key AS draft_pr_key,
  t.corr_key AS corr_key,
  p.url AS pr_url,
  p.process_key AS process_key
FROM plan_tasks t
LEFT JOIN pull_requests p ON p.pr_key = t.pr_key;

CREATE VIEW plan_wave_counts AS
SELECT
  t.plan_key AS plan_key,
  t.wave AS wave,
  COUNT(*) AS total,
  SUM(CASE WHEN p.status = 'merged' THEN 1 ELSE 0 END) AS merged,
  SUM(CASE WHEN p.status = 'merged' THEN 0 WHEN t.status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
  SUM(CASE WHEN p.status = 'merged' THEN 0 WHEN t.status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
  SUM(CASE WHEN p.status = 'merged' THEN 0 WHEN t.status = 'escalated' THEN 1 ELSE 0 END) AS escalated,
  SUM(CASE WHEN p.status = 'merged' THEN 0 WHEN t.status IN ('skipped', 'blocked', 'escalated') THEN 0 ELSE 1 END) AS in_flight
FROM plan_tasks t
LEFT JOIN pull_requests p ON p.pr_key = t.pr_key
WHERE t.wave IS NOT NULL
GROUP BY t.plan_key, t.wave;

CREATE VIEW plan_wave_summary AS
SELECT
  c.plan_key AS plan_key,
  c.wave AS wave,
  c.total AS total,
  c.merged AS merged,
  c.in_flight AS in_flight,
  c.blocked AS blocked,
  c.escalated AS escalated,
  c.skipped AS skipped,
  replace(substr(hex(zeroblob(c.merged)), 1, c.merged), '0', '▓') || replace(substr(hex(zeroblob(c.total - c.merged)), 1, c.total - c.merged), '0', '░') || ' ' || c.merged || '/' || c.total || ' merged' || CASE WHEN c.in_flight > 0 THEN ' · ' || c.in_flight || ' in-flight' ELSE '' END || CASE WHEN c.blocked > 0 THEN ' · ' || c.blocked || ' blocked' ELSE '' END || CASE WHEN c.escalated > 0 THEN ' · ' || c.escalated || ' escalated' ELSE '' END || CASE WHEN c.skipped > 0 THEN ' · ' || c.skipped || ' skipped' ELSE '' END AS bar
FROM plan_wave_counts c;
