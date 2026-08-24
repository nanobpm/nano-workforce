-- Surface delivery-graph runs in the Lineage read model (issue #498: "surface dynamic delivery
-- graphs in the Lineage tab as a fan-in parent thread").
--
-- 064_lineage_thread_view.sql created `lineage_thread_view`, deriving a thread's view-expressible
-- identity columns (`kind`, `title`, `issue_url`) from the `plans` / `feature_runs` origin joins and
-- passing the procedural frontier columns through from `lineage_threads`. It matched a root against
-- exactly two origin tables (else a self-rooted `'pr'`), so a delivery-graph run — a SEPARATE
-- aggregate (`delivery_graph_runs`, keyed by `run_key`) — was structurally invisible: its thread fell
-- through to `'pr'` with a NULL title.
--
-- `collectThreads` (app/lineage.ts) now enumerates `delivery_graph_runs` as a fan-in parent thread
-- keyed on `run_key`, so `pollLineage` writes a `lineage_threads` row for each run. Extend the view
-- with a third origin arm so it derives that row's identity from the run:
--   • `kind`      — 'delivery' when the root matches a `delivery_graph_runs.run_key` (after the
--                   epic/feature arms, mirroring the precedence in `collectThreads` / `deriveLineage`).
--   • `title`     — the run's `title` (its authored delivery-graph title).
--   • `issue_url` — NULL: a delivery-graph run is keyed by `run_key`/`digest`, not a GitHub issue,
--                   exactly as `deriveLineage` sets it (only feature/epic threads root on an issue).
-- The procedural frontier columns (`stage`/`stage_label`/`process_key`/`pr_keys`/`pr_count`/`active`)
-- still pass through from `lineage_threads`, so a delivery thread's frontier reflects the run's
-- derived phase that `pollLineage` wrote.
--
-- A VIEW cannot be `ALTER`ed, so DROP the old definition and CREATE the extended one. This is a NEW
-- forward-only migration — 064 stays immutable. The view remains a plain `CREATE VIEW <name> AS
-- SELECT … FROM …` (no CTE, no select-list subquery, every column aliased) so the static
-- pages↔schema contract guard can still introspect its output columns; the added CASE arm and LEFT
-- JOIN keep the SAME output column set, so the repointed Lineage page renders identically.
--
-- Forward-only, additive: no schema change to any base table, no DROP of `lineage_threads`. The
-- runner wraps each file in its own transaction, so this file must NOT contain BEGIN/COMMIT.

DROP VIEW IF EXISTS lineage_thread_view;

CREATE VIEW lineage_thread_view AS
SELECT
  lt.root_request_key AS root_request_key,
  CASE
    WHEN pl.plan_key IS NOT NULL THEN 'epic'
    WHEN fr.feature_key IS NOT NULL THEN 'feature'
    WHEN dg.run_key IS NOT NULL THEN 'delivery'
    ELSE 'pr'
  END AS kind,
  CASE
    WHEN pl.plan_key IS NOT NULL THEN pl.title
    WHEN fr.feature_key IS NOT NULL THEN fr.title
    WHEN dg.run_key IS NOT NULL THEN dg.title
    ELSE lt.title
  END AS title,
  CASE
    WHEN pl.plan_key IS NOT NULL THEN pl.issue_url
    WHEN fr.feature_key IS NOT NULL THEN fr.issue_url
    ELSE NULL
  END AS issue_url,
  lt.stage AS stage,
  lt.stage_label AS stage_label,
  lt.process_key AS process_key,
  lt.pr_keys AS pr_keys,
  lt.pr_count AS pr_count,
  lt.active AS active,
  lt.created_at AS created_at,
  lt.updated_at AS updated_at
FROM lineage_threads lt
LEFT JOIN plans pl ON pl.plan_key = lt.root_request_key
LEFT JOIN feature_runs fr ON fr.feature_key = lt.root_request_key
LEFT JOIN delivery_graph_runs dg ON dg.run_key = lt.root_request_key;
