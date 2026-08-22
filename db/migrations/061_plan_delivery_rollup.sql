-- Epic delivery read model as a derived VIEW, plus the composite `plans` read model the pages bind
-- (epic #412 — retire worker-maintained projections).
--
-- 029_plan_delivery.sql denormalised `plans.delivery` ('converging'|'landed'|NULL) and
-- `plans.delivery_label` onto the `plans` row, recomputed each poll pass by `pollDelivery`
-- (app/service.ts) which joins each `plan_tasks.pr_key` → `pull_requests.status`. The PURE derivation
-- lives in `deriveDelivery`/`TERMINAL_STATUSES` (app/delivery.ts). Its comment cites the sole reason
-- it was a poller-maintained table rather than a VIEW: "Urban's datasource cannot read a SQL VIEW".
-- That constraint is gone (nano-ide#424), so this expresses the SAME `deriveDelivery` logic as a
-- DERIVED view — a single source of truth with NO write-path and no drift.
--
-- Layered so each view stays a plain `CREATE VIEW <name> AS SELECT … FROM …` (no CTE / no
-- select-list subquery), parseable by scripts/pages-contract.test.ts:
--
--   • plan_delivery_counts — one row per plan_key with the three counts `deriveDelivery` folds over
--                            the slice PRs (only tasks that OPENED a PR — `pr_key IS NOT NULL` —
--                            count, mirroring `pollDelivery`'s `if (!t.pr_key) continue`):
--                              - prs_opened   = number of slice tasks with a PR.
--                              - prs_merged   = those whose PR reached `status = 'merged'`.
--                              - prs_in_flight = those whose PR is NON-terminal (`status` NOT IN
--                                `TERMINAL_STATUSES` = converged/merged/abandoned). A `pr_key` with
--                                no `pull_requests` row (status NULL, the poller's MISSING_PR_STATUS
--                                sentinel) is non-terminal, so it counts as in flight — a DB desync
--                                can never wrongly promote an epic to `landed`.
--   • plan_delivery        — the derived signal + PRE-FORMATTED label, per `deriveDelivery`:
--                              - NULL when the plan is not `done` or opened no PRs (no positive
--                                signal yet), OR every PR is terminal but not all merged
--                                (resolved-not-landed).
--                              - 'converging' + "M/O slices merged, F converging" when ≥1 PR is in
--                                flight.
--                              - 'landed' + "O/O slices merged" when every slice PR merged
--                                (prs_in_flight = 0 AND prs_merged = prs_opened > 0).
--   • plan_read_model      — the `plans` row with its wave (060) and delivery projections DERIVED
--                            from the views instead of read from the denormalised columns. This is
--                            the datasource the operator pages (overview / epic-detail) bind, so that
--                            when the wave-1 cleanup task DROPs plans.wave_label / plans.current_wave
--                            / plans.wave_count / plans.delivery / plans.delivery_label, every page
--                            already reads the single-source-of-truth views. It projects only the
--                            `plans` columns those pages reference, plus the five derived columns.
--
-- Forward-only, additive. NO BEGIN/COMMIT — the runner wraps each file in its own transaction.

CREATE VIEW plan_delivery_counts AS
SELECT
  t.plan_key AS plan_key,
  COUNT(t.pr_key) AS prs_opened,
  SUM(CASE WHEN t.pr_key IS NOT NULL AND p.status = 'merged' THEN 1 ELSE 0 END) AS prs_merged,
  SUM(CASE WHEN t.pr_key IS NOT NULL AND (p.status IS NULL OR p.status NOT IN ('converged', 'merged', 'abandoned')) THEN 1 ELSE 0 END) AS prs_in_flight
FROM plan_tasks t
LEFT JOIN pull_requests p ON p.pr_key = t.pr_key
GROUP BY t.plan_key;

CREATE VIEW plan_delivery AS
SELECT
  pl.plan_key AS plan_key,
  CASE
    WHEN pl.status IS NOT 'done' OR COALESCE(c.prs_opened, 0) = 0 THEN NULL
    WHEN COALESCE(c.prs_in_flight, 0) > 0 THEN 'converging'
    WHEN c.prs_merged = c.prs_opened THEN 'landed'
    ELSE NULL
  END AS delivery,
  CASE
    WHEN pl.status IS NOT 'done' OR COALESCE(c.prs_opened, 0) = 0 THEN NULL
    WHEN COALESCE(c.prs_in_flight, 0) > 0 THEN c.prs_merged || '/' || c.prs_opened || ' slices merged, ' || c.prs_in_flight || ' converging'
    WHEN c.prs_merged = c.prs_opened THEN c.prs_opened || '/' || c.prs_opened || ' slices merged'
    ELSE NULL
  END AS delivery_label
FROM plans pl
LEFT JOIN plan_delivery_counts c ON c.plan_key = pl.plan_key;

CREATE VIEW plan_read_model AS
SELECT
  pl.plan_key AS plan_key,
  pl.repo AS repo,
  pl.issue_number AS issue_number,
  pl.issue_url AS issue_url,
  pl.title AS title,
  pl.status AS status,
  pl.task_count AS task_count,
  pl.process_key AS process_key,
  pl.outcome AS outcome,
  pl.updated_at AS updated_at,
  pl.epic_phase AS epic_phase,
  pl.base_branch AS base_branch,
  pl.wait_gate_label AS wait_gate_label,
  pl.bound_artifacts AS bound_artifacts,
  pl.promotion_pr AS promotion_pr,
  pl.promotion_state AS promotion_state,
  pl.list_bucket AS list_bucket,
  pl.ack_open AS ack_open,
  wl.wave_count AS wave_count,
  wl.current_wave AS current_wave,
  wl.wave_label AS wave_label,
  d.delivery AS delivery,
  d.delivery_label AS delivery_label
FROM plans pl
LEFT JOIN plan_wave_label wl ON wl.plan_key = pl.plan_key
LEFT JOIN plan_delivery d ON d.plan_key = pl.plan_key;
