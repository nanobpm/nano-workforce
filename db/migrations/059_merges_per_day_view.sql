-- Retire the worker-maintained `merges_per_day` projection in favour of a derived SQL VIEW
-- (issue #412; generalises #411's VIEW pattern). Depends-on: nanobpm/nano-ide#424.
--
-- `051_merges_per_day.sql` created `merges_per_day` as a DENORMALISED flat table, recomputed each
-- poll pass by `pollMergesPerDay` (app/mergesPerDay.ts) — its own comment cites the sole reason:
-- "the natural home for that aggregate would be a SQL VIEW, but Urban's page datasource cannot read
-- one". That reason is now GONE: since nanobpm/nano-ide#424 (urban ≥ 0.75) the datasource `schema()`
-- introspects `type IN ('table','view')` and tags a view read-only, so a page can bind a VIEW
-- verbatim. Keeping the hand-maintained table alongside the audit trail it is fully derivable from is
-- exactly the drift surface AGENTS.md's "derivation over duplication" rule forbids — so we replace it
-- with the VIEW and delete the worker write-path (`pollMergesPerDay`, and its call in app/service.ts).
--
-- The VIEW reproduces `deriveMergesPerDay` (the pure aggregate that WAS the projection's source of
-- truth) over production-shaped audit rows, column-for-column: it is the canonical aggregate the
-- 051 comment already documented, plus the burn-up `cumulative` and the proportional `bar`:
--
--   • day        — `date(at, 'localtime')`: the LOCAL calendar day (issue #361), matching the host
--                  zone the poller bucketed in (it omitted an explicit IANA zone, so used the host's
--                  resolved zone — the SQL `'localtime'` twin). Production `merges.at` values are
--                  always `new Date().toISOString()` (UTC, `Z`-suffixed), so the day is unambiguous;
--                  the pure fn's extra malformed/ambiguous-string fallbacks only guarded defensive
--                  unit rows that never occur in the audit, so the VIEW needs no counterpart.
--   • merged     — `COUNT(DISTINCT pr_key)` of `outcome = 'merged'` rows (a retry / already-merged
--                  short-circuit that logs several rows for one PR on one day still counts once);
--                  `queued`/`blocked`/other outcomes are ignored.
--   • cumulative — running burn-up total: `SUM(merged) OVER (ORDER BY day)`. `date()` emits
--                  `YYYY-MM-DD`, which sorts lexically == chronologically, so the ordered window is
--                  the same ascending running total the pure fn accumulates.
--   • bar        — proportional block-character bar scaled against the busiest day
--                  (`max = MAX(merged) OVER ()`): `max(1, round(merged/max * 30))` glyphs for any
--                  non-zero day (so a lone merge stays visible), empty for zero — the same
--                  `barFor(merged, max)` the pure fn draws. `replace(hex(zeroblob(n)), '00', '█')`
--                  emits exactly `n` copies of the block glyph (SQLite has no `repeat`); `round()`
--                  rounds half away from zero, which equals JS `Math.round` for the non-negative
--                  inputs here. The `dataGrid`/`prose` renderer draws this pre-formatted string with
--                  no per-cell templating, so the VIEW must emit it verbatim (AGENTS.md).
--
-- A VIEW cannot share a name with the table it replaces, and every reader binds the name
-- `merges_per_day` (the Velocity page datasource, unchanged). This same-name swap is therefore the
-- CONTRACT phase for this projection: the poller write-path is removed in the same PR, so nothing
-- reads or writes the flat table after this migration — we DROP it and CREATE the VIEW atomically in
-- its place. Forward-only; the runner wraps each file in its own transaction, so no BEGIN/COMMIT.
-- Numbered after the current highest prefix (058) on origin/main.
DROP TABLE IF EXISTS merges_per_day;

CREATE VIEW merges_per_day AS
WITH daily AS (
  SELECT date(at, 'localtime') AS day, COUNT(DISTINCT pr_key) AS merged
  FROM merges
  WHERE outcome = 'merged'
  GROUP BY date(at, 'localtime')
),
scaled AS (
  SELECT
    day,
    merged,
    SUM(merged) OVER (ORDER BY day) AS cumulative,
    MAX(merged) OVER () AS max_merged
  FROM daily
)
SELECT
  day,
  merged,
  cumulative,
  CASE
    WHEN merged <= 0 OR max_merged <= 0 THEN ''
    ELSE replace(
      hex(zeroblob(max(1, CAST(round(CAST(merged AS REAL) / max_merged * 30) AS INTEGER)))),
      '00',
      '█'
    )
  END AS bar
FROM scaled
ORDER BY day;
