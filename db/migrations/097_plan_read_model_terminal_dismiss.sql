-- Epic `plan_read_model`: fold the terminal-non-`done` dismissal arm into the Active/History partition
-- (issue #641, Scope C). SUPERSEDES 083's VIEW body — every DERIVED column is emitted VERBATIM from the
-- ONE `planReadModel` declaration (app/planReadModel.ts), now with `list_bucket`/`ack_open` classified
-- over the SHARED acknowledge-to-dismiss oracle (app/listBucket.ts) parameterised by the epic terminal
-- set {done, failed, abandoned}. 061/074/080/083 are MERGED, IMMUTABLE migrations — never edited; this
-- is a NEW migration superseding 083's VIEW body (the pattern by which 083 superseded 080).
--
-- WHY. Epics already stayed active-until-dismissed on the SUCCESS path (a `done` epic). But a terminal-
-- non-`done` epic (`failed`/`abandoned` — cancelled) fell STRAIGHT to History (the old bucket CASE's
-- default), skipping the operator tick-off. For true uniformity with features/PRs/delivery-graphs, the
-- new `list_bucket` keeps a terminal-but-UNACKNOWLEDGED epic of ANY terminal status in `active` until
-- dismissed, and `ack_open` extends the Dismiss affordance from `done`-only to the full terminal set (a
-- `failed`/`abandoned` epic's `delivery` is always non-`converging`, so it is immediately dismissable).
--
-- Every DERIVED column below is emitted VERBATIM from `planReadModel.sqlSelectFor(col, { baseAlias:
-- "pl" })` (which ALSO drives the runtime TS via `fnFor`, behind the app/delivery.ts adapters). The
-- drift guard (app/planReadModel.test.ts) fails if this file stops matching the declaration, and
-- `assertReadModelParity` proves the SQL and TS lowerings agree.
--
-- SEMANTICS unchanged from 083 EXCEPT `list_bucket`/`ack_open`: `delivery` still reads the base
-- `plans.status`; the status-classifying arms read the terminal-folded `derived_status`; the wave
-- columns pass through the `plan_wave_progress` lookup; the display strings (`delivery_label`,
-- `wave_label`) stay hand-authored. Base columns stay aliased pass-throughs; `status` is the effective
-- `COALESCE(derived_status, status)`. The two rollup lookups are re-joined identically.
--
-- Forward-only VIEW redefinition (DROP then CREATE). `plans__tracking` is the managed VIEW urban
-- provisions at mount; SQLite does not validate a view body at CREATE time, so this migration (which
-- runs before that mount) is created fine and resolves once the managed VIEW exists. The runner wraps
-- each file in its own transaction, so this file must NOT contain BEGIN/COMMIT. Numbered after 096.

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
