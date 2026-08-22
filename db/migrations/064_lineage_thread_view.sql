-- Lineage read-model: derive the view-expressible identity columns of `lineage_threads` (epic
-- #412 — "Retire worker-maintained denormalized projections in favour of SQL VIEWs").
--
-- `lineage_threads` (037_lineage.sql) is a denormalised read table `pollLineage` (app/lineage.ts)
-- rewrites every poll pass, stitching request → implementation → PR(s) → convergence → merge into
-- one narrative per `root_request_key`. Its comment cited "Urban's datasource cannot read a SQL
-- VIEW" as the sole reason to denormalise; nano-ide#424 removed that constraint (gateway.schema()
-- now introspects `type IN ('table','view')`), so the parts that are plain rollups of data that
-- ALREADY exists should be DERIVED, not duplicated (AGENTS.md "Derivation over duplication / no
-- drift surfaces"), exactly as 059_plan_wave_summary.sql did for the plans wave/delivery rollups.
--
-- AUDIT — per column, is it a clean rollup or genuinely procedural?
--
--   VIEW-EXPRESSIBLE (pure structural function of which origin table the root matches — no frontier
--   logic, no representative-PR selection, no formatting — so a plain parseable view reproduces them
--   EXACTLY as `deriveLineage` does):
--     • `kind`      — 'epic' when the root is a `plans.plan_key`, 'feature' when it is a
--                     `feature_runs.feature_key`, else 'pr' (self-rooted human/webhook PR). The
--                     epic-before-feature precedence mirrors `collectThreads`, which sets the plan
--                     thread after the feature thread for the same key.
--     • `issue_url` — the matched origin's `issue_url` (`plans`/`feature_runs`), NULL for a
--                     self-rooted PR — exactly `deriveLineage`'s `origin.kind === "pr" ? null : …`.
--     • `title`     — the matched origin's `title` for an epic/feature thread. A self-rooted PR's
--                     title is the PROCEDURAL representative-PR pick, so it falls back to the
--                     poller-written `lineage_threads.title` for kind 'pr' (see below).
--
--   PROCEDURAL (multi-stage frontier / ordering logic in the pure `deriveLineage`, which selects a
--   representative PR — "first non-terminal by pr_key, else last by pr_key" — branches on origin
--   kind + feature pre-hand-off, rolls epic fan-out up via `deriveDelivery`, and formats round /
--   slice-count label strings; none of this is a plain no-CTE / no-select-list-subquery view, and
--   forcing it would risk diverging from the tested derivation): `stage`, `stage_label`,
--   `process_key`, `active`, plus the membership columns `pr_count` / `pr_keys` (which union a
--   root's threaded PRs with its origin's own `pr_key` / `plan_tasks.pr_key` and dedupe across
--   roots — not a clean grouped join) and the self-rooted `title`. These stay written by
--   `pollLineage` for the wave-1 cleanup task to trim; this view PASSES THEM THROUGH from
--   `lineage_threads` so the single Lineage grid keeps rendering identically.
--
-- The view is a plain `CREATE VIEW <name> AS SELECT … FROM …` — no CTE, no select-list subquery,
-- every column aliased — so the static pages↔schema contract guard (scripts/pages-contract.test.ts)
-- can introspect its output columns to whitelist the repointed page. CASE / COALESCE in the select
-- list are fine (they are not subqueries).
--
-- Forward-only, additive: a new read model, no schema change to any base table, no DROP. The runner
-- wraps each file in its own transaction, so this file must NOT contain BEGIN/COMMIT. This task owns
-- the disjoint migration block 064-069; a single view suffices, so 065-069 are left unused.

CREATE VIEW lineage_thread_view AS
SELECT
  lt.root_request_key AS root_request_key,
  CASE
    WHEN pl.plan_key IS NOT NULL THEN 'epic'
    WHEN fr.feature_key IS NOT NULL THEN 'feature'
    ELSE 'pr'
  END AS kind,
  CASE
    WHEN pl.plan_key IS NOT NULL THEN pl.title
    WHEN fr.feature_key IS NOT NULL THEN fr.title
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
LEFT JOIN feature_runs fr ON fr.feature_key = lt.root_request_key;
