-- Merged-per-day throughput / burn-up read model (issue #344).
--
-- Every land is already audited in `merges` (004_merge.sql): one row per merge attempt, whose
-- `outcome` includes `merged`, `queued`, `blocked` and `retry` (the set is not exhaustive) and
-- `at` = ISO timestamp. Only `outcome = 'merged'` rows count. The per-calendar-day merged count is
-- therefore fully DERIVABLE from that audit trail — no new write-path bookkeeping (AGENTS.md:
-- "Derivation over duplication"). The canonical aggregate is:
--
--   SELECT date(at) AS day, COUNT(DISTINCT pr_key) AS merged
--   FROM merges WHERE outcome = 'merged' GROUP BY date(at);
--
-- `COUNT(DISTINCT pr_key)` (not `COUNT(*)`) so a PR that produced several audit rows on one day —
-- e.g. an `already-merged` short-circuit or a retry — counts once per day.
--
-- The natural home for that aggregate would be a SQL VIEW, but Urban's page datasource cannot read
-- one: `gateway.ts schema()` whitelists `sqlite_master.type = 'table'` only, so a page binding to a
-- VIEW 400s at request time (see the `lineage_threads` / `plans.delivery` precedent, 037_lineage.sql).
-- So — following the codebase convention for read-model projections — this is a DENORMALISED flat
-- table the schema-driven Velocity page reads directly, recomputed idempotently each poll pass by
-- `pollMergesPerDay` (app/mergesPerDay.ts) from the `merges` audit rows. `cumulative` is the burn-up
-- running total; `bar` is a precomputed proportional block-character bar so the declarative `prose`
-- renderer can draw a horizontal bar per day with no chart node type.
--
-- Forward-only, additive (expand): a new derived read table. The runner wraps each file in its own
-- transaction, so this file must NOT contain BEGIN/COMMIT. Numbered after the current highest prefix
-- (050). `day` is the PRIMARY KEY, which SQLite already indexes, so no extra index is needed.
CREATE TABLE IF NOT EXISTS merges_per_day (
  day        TEXT PRIMARY KEY,             -- calendar day (date(at), ISO YYYY-MM-DD)
  merged     INTEGER NOT NULL DEFAULT 0,   -- COUNT(DISTINCT pr_key) merged that day
  cumulative INTEGER NOT NULL DEFAULT 0,   -- running total of merged PRs up to and including `day` (burn-up)
  bar        TEXT NOT NULL DEFAULT '',     -- proportional block-character bar for the prose chart
  updated_at TEXT NOT NULL
);
