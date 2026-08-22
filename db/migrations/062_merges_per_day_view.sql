-- Merged-per-day throughput / burn-up as a derived SQL VIEW (epic #412, retiring the 051 flat table).
--
-- 051_merges_per_day.sql created the DENORMALISED `merges_per_day` read table (day / merged /
-- cumulative / bar) that `pollMergesPerDay` (app/mergesPerDay.ts) recomputes each poll pass from the
-- `merges` audit rows (004_merge.sql). Its comment cites the ONE reason it could not simply be a
-- VIEW: "Urban's page datasource cannot read a SQL VIEW" (gateway.ts `schema()` whitelisted
-- `type='table'` only). That constraint is GONE — nano-ide#424 made `gateway.schema()` introspect
-- `type IN ('table','view')` and tag a view read-only, and #411 (059_plan_wave_summary.sql)
-- established the layered-VIEW pattern. So the aggregate becomes what AGENTS.md always wanted
-- ("Derivation over duplication"): a VIEW that is a single source of truth with NO write-path and no
-- possibility of drift from the `merges` audit trail.
--
-- This migration is WAVE-0 / PURELY ADDITIVE: it adds the VIEW and the Velocity page is repointed
-- onto it, but the `merges_per_day` TABLE and its `pollMergesPerDay` write-path are LEFT IN PLACE (a
-- harmless duplicate) so the surface never goes stale while both coexist. A wave-1 cleanup task
-- ("retire-projection-writepaths-cleanup") drops the table and deletes the write-path AFTER this
-- merges.
--
-- The VIEW must reproduce the CURRENT projection EXACTLY, including two subtleties beyond the 051
-- comment's canonical `SELECT date(at) AS day, COUNT(DISTINCT pr_key) …`:
--   • the day is bucketed in the operator's LOCAL calendar day (issue #361) — `date(at, 'localtime')`,
--     not UTC — matching `deriveMergesPerDay`, so a merge either side of a local midnight lands on the
--     day the operator saw it;
--   • `bar` is the SAME pre-formatted proportional block-character string the `prose` renderer draws
--     today (the renderer has no per-cell templating / no chart node, so the bar must arrive
--     ready-to-show): a run of `█` glyphs whose length is `max(1, round((merged / busiest) * 30))`
--     (min one glyph for any non-zero day; the busiest day is 30 wide), i.e. exactly
--     `barFor()`/`BAR_WIDTH`/`BAR_FULL` in app/mergesPerDay.ts.
--
-- Layered into TWO plain views so each is a `CREATE VIEW <name> AS SELECT … FROM …` with NO CTE and
-- NO select-list subquery — which keeps them parseable by the static pages↔schema contract guard
-- (scripts/pages-contract.test.ts), exactly as 059 layers its counts → summary:
--
--   • merges_per_day_counts — one row per local calendar day: `day` + `merged`
--     (COUNT(DISTINCT pr_key) so a PR with several `merged` audit rows on one day — an
--     already-merged short-circuit or a retry — counts once; `queued`/`blocked` rows are excluded).
--   • merges_per_day_view   — the same rows PLUS the burn-up `cumulative`
--     (`SUM(merged) OVER (ORDER BY day)` — a window function in the select list, allowed by the
--     guard) and the pre-formatted `bar`. The bar length uses `MAX(merged) OVER ()` (the busiest
--     day) as the scale; the block run is built with SQLite string funcs
--     (`hex(zeroblob(n))` → 2n '0' chars → `substr` to n → `replace` to the `█` glyph), the same
--     trick 059 uses for its progress bar. Both live in the SELECT list, not a subquery, so the
--     guard can still read every output column.
--
-- Forward-only, additive (a new read model, no change to any base table). The runner wraps each file
-- in its own transaction, so this file must NOT contain BEGIN/COMMIT.

CREATE VIEW merges_per_day_counts AS
SELECT
  date(m.at, 'localtime') AS day,
  COUNT(DISTINCT m.pr_key) AS merged
FROM merges m
WHERE m.outcome = 'merged'
GROUP BY date(m.at, 'localtime');

CREATE VIEW merges_per_day_view AS
SELECT
  c.day AS day,
  c.merged AS merged,
  SUM(c.merged) OVER (ORDER BY c.day) AS cumulative,
  CASE
    WHEN c.merged <= 0 OR MAX(c.merged) OVER () <= 0 THEN ''
    ELSE replace(
      substr(
        hex(zeroblob(max(1, CAST(round((c.merged * 1.0 / MAX(c.merged) OVER ()) * 30.0) AS INTEGER)))),
        1,
        max(1, CAST(round((c.merged * 1.0 / MAX(c.merged) OVER ()) * 30.0) AS INTEGER))
      ),
      '0', '█'
    )
  END AS bar
FROM merges_per_day_counts c;
