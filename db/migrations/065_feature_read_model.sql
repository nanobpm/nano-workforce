-- Feature-run display projection as a derived SQL VIEW (issue #439 — the status-driven follow-up to
-- epic #412).
--
-- 039_feature_pipeline_stage.sql denormalised the pipeline projection
-- (`stage`/`stage_state`/`stage_skipped`/`attention`/`list_bucket`) onto the `feature_runs` row,
-- projected at WRITE TIME by the `featureRuns()` gateway (app/feature.ts) from the pure `deriveStage`
-- / `deriveListBucket` (app/stage.ts). That "the gateway is the sole write path" invariant held for
-- app-layer writes but NOT for the framework `instanceTracking` reconciler, which writes
-- `feature_runs.status` through the RAW datasource (`{status:"abandoned"}` on a terminated instance,
-- see nano.app.json → instanceTracking) — bypassing the gateway, so `status` flipped terminal while
-- the display columns stayed frozen at their pre-terminal values (a cancelled run wedged in Active as
-- a live-looking `Implementing ⚠`, its Dismiss gated shut on a null `stage_state`).
--
-- The fix is the same technique #412/#411 established (projection → VIEW, enabled by nano-ide#424):
-- express the derived columns as a VIEW over `status` (+ `pr_key`/`converge`/`auto_merge`/
-- `acknowledged_at`), removing the write-time projection entirely. There is then no stored column and
-- no write-path for ANY writer (the reconciler or a future one) to leave stale — the projection is a
-- pure function of the row's own base columns, recomputed on every read. `deriveStage` /
-- `deriveListBucket` remain the canonical TS implementation (used by the acknowledge operations and
-- as the test oracle); this VIEW's CASE expressions MIRROR them exactly, and
-- app/featureReadModel.test.ts pins the two in lockstep over the full status matrix.
--
-- A single plain `CREATE VIEW <name> AS SELECT … FROM …` (no CTE / no select-list subquery), so its
-- output columns stay parseable by the static pages↔schema contract guard (scripts/pages-contract.
-- test.ts) — every projected column is aliased and the derived ones are wrapped so nothing but the
-- real table reference reads as the top-level FROM. It projects the `feature_runs` columns the Feature
-- page references PLUS the five derived columns (same shape as 061's plan_read_model): the base
-- `stage`/`stage_state`/`stage_skipped`/`attention`/`list_bucket` columns are deliberately NOT
-- selected — the derived CASE expressions take those names — so a stale stored value can never surface.
--
-- Forward-only, additive (a new read model, no schema change to feature_runs). The runner wraps each
-- file in its own transaction, so this file must NOT contain BEGIN/COMMIT. Numbered after the current
-- highest prefix (064).

CREATE VIEW feature_read_model AS
SELECT
  fr.feature_key AS feature_key,
  fr.repo AS repo,
  fr.issue_number AS issue_number,
  fr.issue_url AS issue_url,
  fr.title AS title,
  fr.base_branch AS base_branch,
  fr.status AS status,
  fr.process_key AS process_key,
  fr.pr_key AS pr_key,
  fr.converge AS converge,
  fr.auto_merge AS auto_merge,
  fr.outcome AS outcome,
  fr.delivery_label AS delivery_label,
  fr.acknowledged_at AS acknowledged_at,
  fr.created_at AS created_at,
  fr.updated_at AS updated_at,
  (CASE
    WHEN fr.status IN ('merged', 'converged', 'blocked', 'failed', 'skipped', 'abandoned') THEN 'Done'
    WHEN fr.status = 'converging' THEN 'Converging'
    WHEN (fr.pr_key IS NOT NULL AND fr.pr_key <> '') OR fr.status = 'opened' THEN 'PR open'
    WHEN fr.status IN ('running', 'escalated', 'awaiting_operator') THEN 'Implementing'
    ELSE 'Requested'
  END) AS stage,
  (CASE
    WHEN fr.status IN ('merged', 'converged') THEN 'ok'
    WHEN fr.status = 'blocked' THEN 'blocked'
    WHEN fr.status IN ('failed', 'skipped', 'abandoned') THEN 'failed'
    ELSE NULL
  END) AS stage_state,
  (CASE
    WHEN NOT (fr.converge IS NOT NULL AND fr.converge <> 0) THEN 'Converging Merging'
    WHEN NOT (fr.auto_merge IS NOT NULL AND fr.auto_merge <> 0) THEN 'Merging'
    ELSE ''
  END) AS stage_skipped,
  (CASE
    WHEN fr.status = 'awaiting_operator' THEN 'blocked'
    WHEN fr.status = 'escalated' THEN '⚠'
    ELSE NULL
  END) AS attention,
  (CASE
    WHEN fr.status IN ('merged', 'converged', 'blocked', 'failed', 'skipped', 'abandoned') AND fr.acknowledged_at IS NOT NULL THEN 'history'
    ELSE 'active'
  END) AS list_bucket
FROM feature_runs fr;
