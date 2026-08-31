-- Plan (Epic) read model: pass `acknowledged_at` through the `plan_read_model` VIEW (issue #654).
-- SUPERSEDES 097's VIEW body — every DERIVED column (`delivery`/`list_bucket`/`ack_open`) is emitted
-- VERBATIM from the ONE declaration in app/planReadModel.ts, unchanged from 097; the ONLY difference is
-- the added `pl.acknowledged_at AS acknowledged_at` base pass-through. 097 is a MERGED, IMMUTABLE
-- migration — never edited; this is a NEW migration superseding its VIEW body (the same pattern by which
-- 097 superseded 083's plan_read_model body, and 099 the feature_read_model body).
--
-- WHY. The shared `acknowledgeVia` helper (app/acknowledge.ts, #654) reads BOTH `ack_open` AND
-- `acknowledged_at` off the read-model VIEW: `ack_open=0` is EITHER an already-acknowledged terminal row
-- (idempotent no-op → 200) OR a still-live / non-terminal one (→ 409), and it disambiguates the two on
-- whether `acknowledged_at` is set. The PR / feature / delivery-graph read models (094/099/096) each
-- already pass `acknowledged_at` through, but `plan_read_model` only READ it inside the `list_bucket` /
-- `ack_open` CASE bodies and never PROJECTED it — so `acknowledgeEpic` saw `row.acknowledged_at ===
-- undefined` and re-dismissing an already-acknowledged epic incorrectly 409'd instead of returning the
-- idempotent 200. This VIEW adds the missing pass-through so all four dismissable surfaces expose the
-- same columns the one helper depends on (parity, no drift).
--
-- SEMANTICS unchanged from 097 EXCEPT the one added `acknowledged_at` pass-through: the status-
-- classifying columns still read the terminal-folded `plans__tracking.derived_status`; base columns stay
-- aliased identity pass-throughs; the derived `delivery`/`list_bucket`/`ack_open`/display columns are
-- byte-identical to 097 (still drift-guarded against app/planReadModel.ts).
--
-- Forward-only VIEW redefinition (DROP then CREATE). `plans__tracking` is the managed VIEW urban
-- provisions at mount; SQLite does not validate a view body at CREATE time, so this migration (which
-- runs before that mount) is created fine and resolves once the managed VIEW exists. The runner wraps
-- each file in its own transaction, so this file must NOT contain BEGIN/COMMIT. Numbered after 099.

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
  CASE WHEN COALESCE(((NOT COALESCE(COALESCE(("pl"."status" = 'done'), 0), 0)) OR COALESCE((COALESCE("dc"."prs_opened", 0) = 0), 0)), 0) THEN NULL WHEN COALESCE((COALESCE("dc"."prs_in_flight", 0) > 0), 0) THEN 'converging' WHEN COALESCE((COALESCE("dc"."prs_merged", 0) = COALESCE("dc"."prs_opened", 0)), 0) THEN 'landed' ELSE NULL END AS delivery,
  "wp"."wave_count" AS wave_count,
  "wp"."current_wave" AS current_wave,
  CASE WHEN COALESCE((COALESCE((COALESCE((COALESCE(("pl"."derived_status" = 'done'), 0) OR COALESCE(("pl"."derived_status" = 'failed'), 0) OR COALESCE(("pl"."derived_status" = 'abandoned'), 0)), 0) AND (NOT COALESCE(COALESCE((CASE WHEN COALESCE(((NOT COALESCE(COALESCE(("pl"."status" = 'done'), 0), 0)) OR COALESCE((COALESCE("dc"."prs_opened", 0) = 0), 0)), 0) THEN NULL WHEN COALESCE((COALESCE("dc"."prs_in_flight", 0) > 0), 0) THEN 'converging' WHEN COALESCE((COALESCE("dc"."prs_merged", 0) = COALESCE("dc"."prs_opened", 0)), 0) THEN 'landed' ELSE NULL END = 'converging'), 0), 0))), 0) AND COALESCE(("pl"."acknowledged_at" = "pl"."acknowledged_at"), 0)), 0) THEN 'history' ELSE 'active' END AS list_bucket,
  CASE WHEN COALESCE((COALESCE((COALESCE((COALESCE(("pl"."derived_status" = 'done'), 0) OR COALESCE(("pl"."derived_status" = 'failed'), 0) OR COALESCE(("pl"."derived_status" = 'abandoned'), 0)), 0) AND (NOT COALESCE(COALESCE((CASE WHEN COALESCE(((NOT COALESCE(COALESCE(("pl"."status" = 'done'), 0), 0)) OR COALESCE((COALESCE("dc"."prs_opened", 0) = 0), 0)), 0) THEN NULL WHEN COALESCE((COALESCE("dc"."prs_in_flight", 0) > 0), 0) THEN 'converging' WHEN COALESCE((COALESCE("dc"."prs_merged", 0) = COALESCE("dc"."prs_opened", 0)), 0) THEN 'landed' ELSE NULL END = 'converging'), 0), 0))), 0) AND (NOT COALESCE(COALESCE(("pl"."acknowledged_at" = "pl"."acknowledged_at"), 0), 0))), 0) THEN 1 ELSE 0 END AS ack_open,
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
