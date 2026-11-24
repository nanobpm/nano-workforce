-- Re-create the `plan_read_model` VIEW from the CURRENT `sqlSelectFor` output.
-- @nanobpm/urban 0.100.0 (nano-ide#625) stopped COALESCE-wrapping projection predicates inside
-- EXISTS/WHERE/CASE, so SQLite can use its indexes (e.g. the `merges` lookup behind
-- `pull_requests_read_model`). The derived columns are emitted VERBATIM from app/featureReadModel.ts,
-- app/deliveryGraphReadModel.ts, app/planReadModel.ts and app/pullRequestReadModel.ts; the base
-- pass-throughs, display columns, FROM/JOINs are unchanged from 112 / 146 / 100 / 138 respectively.
-- Semantics are unchanged (the declarations' NULL handling is preserved by the new lowering — the
-- FRAMEWORK PARITY GUARDs check SQL↔TS agreement). No BEGIN/COMMIT (the runner wraps each file).
-- Numbered after 147.

DROP VIEW IF EXISTS plan_read_model;

CREATE VIEW plan_read_model AS
SELECT
  pl.plan_key AS plan_key,
  pl.repo AS repo,
  pl.issue_number AS issue_number,
  pl.issue_url AS issue_url,
  pl.title AS title,
  COALESCE(pl.derived_status, pl.status) AS status,
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
  pl.acknowledged_at AS acknowledged_at,
  CASE WHEN ((NOT COALESCE(COALESCE(("pl"."status" = 'done'), 0), 0)) OR (COALESCE("dc"."prs_opened", 0) = 0)) THEN NULL WHEN (COALESCE("dc"."prs_in_flight", 0) > 0) THEN 'converging' WHEN (COALESCE("dc"."prs_merged", 0) = COALESCE("dc"."prs_opened", 0)) THEN 'landed' ELSE NULL END AS delivery,
  "wp"."wave_count" AS wave_count,
  "wp"."current_wave" AS current_wave,
  CASE WHEN (((("pl"."derived_status" = 'done') OR ("pl"."derived_status" = 'failed') OR ("pl"."derived_status" = 'abandoned')) AND (NOT COALESCE(COALESCE((CASE WHEN ((NOT COALESCE(COALESCE(("pl"."status" = 'done'), 0), 0)) OR (COALESCE("dc"."prs_opened", 0) = 0)) THEN NULL WHEN (COALESCE("dc"."prs_in_flight", 0) > 0) THEN 'converging' WHEN (COALESCE("dc"."prs_merged", 0) = COALESCE("dc"."prs_opened", 0)) THEN 'landed' ELSE NULL END = 'converging'), 0), 0))) AND ("pl"."acknowledged_at" = "pl"."acknowledged_at")) THEN 'history' ELSE 'active' END AS list_bucket,
  CASE WHEN (((("pl"."derived_status" = 'done') OR ("pl"."derived_status" = 'failed') OR ("pl"."derived_status" = 'abandoned')) AND (NOT COALESCE(COALESCE((CASE WHEN ((NOT COALESCE(COALESCE(("pl"."status" = 'done'), 0), 0)) OR (COALESCE("dc"."prs_opened", 0) = 0)) THEN NULL WHEN (COALESCE("dc"."prs_in_flight", 0) > 0) THEN 'converging' WHEN (COALESCE("dc"."prs_merged", 0) = COALESCE("dc"."prs_opened", 0)) THEN 'landed' ELSE NULL END = 'converging'), 0), 0))) AND (NOT COALESCE(COALESCE(("pl"."acknowledged_at" = "pl"."acknowledged_at"), 0), 0))) THEN 1 ELSE 0 END AS ack_open,
  CASE
    WHEN pl.status IS NOT 'done' OR COALESCE(dc.prs_opened, 0) = 0 THEN NULL
    WHEN COALESCE(dc.prs_in_flight, 0) > 0 THEN dc.prs_merged || '/' || dc.prs_opened || ' slices merged, ' || dc.prs_in_flight || ' converging'
    WHEN dc.prs_merged = dc.prs_opened THEN dc.prs_opened || '/' || dc.prs_opened || ' slices merged'
    ELSE NULL
  END AS delivery_label,
  (wp.current_wave + 1) || '/' || wp.wave_count AS wave_label
FROM plans__tracking pl
LEFT JOIN plan_delivery_counts dc ON pl.plan_key = dc.plan_key
LEFT JOIN plan_wave_progress wp ON pl.plan_key = wp.plan_key;
