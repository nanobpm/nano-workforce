-- Epic `plan_read_model` per-row signals, authored ONCE via Urban's ADR-0065 reconciling-read-model
-- primitive (`defineReadModel` + key-correlated rollup lookups, app/planReadModel.ts,
-- `@nanobpm/urban@0.82.0` / nano-ide#468) — issue #493 (the plan-family twin of 076/081's feature
-- read-model declare-once; the exemplar is app/featureReadModel.ts).
--
-- 061_plan_delivery_rollup.sql, 074_plan_read_model_derive_bucket.sql and
-- 080_plan_read_model_derive_terminal.sql hand-authored the epic per-row signals — `delivery`
-- (converging/landed/NULL), the Active/History `list_bucket`, and the operator-Dismiss `ack_open`
-- flag — as SQL `CASE` expressions inside the `plan_delivery` / `plan_read_model` VIEWs, AND a SECOND
-- time in the runtime TS (`deriveDelivery`/`deriveEpicBucket`/`epicIsAcknowledgeable`, app/delivery.ts),
-- kept in lockstep by hand-written parity tests (ADR-0065 drift surface #2). This migration SUPERSEDES
-- 080's `plan_read_model` VIEW body: every DERIVED column below is emitted VERBATIM from the ONE
-- `planReadModel` declaration (`planReadModel.sqlSelectFor(col, { baseAlias: "pl" })`), which ALSO
-- drives the runtime TS via `fnFor` (behind the app/delivery.ts adapters). The two lowerings fall out
-- of the same closed-DSL AST and cannot diverge; the drift guard (app/planReadModel.test.ts) fails if
-- this file stops matching the declaration, and `assertReadModelParity` proves the SQL and TS lowerings
-- agree. 061/074/080 are MERGED, IMMUTABLE migrations — never edited; this is a NEW migration
-- superseding 080's VIEW body (the pattern by which 080 superseded 074).
--
-- SEMANTICS are unchanged from 080 (validated byte-identical over a random corpus): the status-
-- classifying `list_bucket`/`ack_open` arms read the terminal-folded `derived_status` off the
-- auto-provisioned `plans__tracking` derived VIEW (so a cancelled epic drops out of Active with no
-- worker write, issue #503); `delivery` reads the base `plans.status` (`done` is already terminal, so
-- base and effective agree on the `= 'done'` gate, and this keeps `delivery` byte-identical to the
-- retired `plan_delivery` VIEW and to `deriveDelivery(plan.status, …)`'s call sites). The single-valued
-- rollup lookups the CASEs consume are `LEFT JOIN plan_delivery_counts dc` (slice-PR counts, defaulted
-- to 0 on a miss) and `LEFT JOIN plan_wave_progress wp` (the wave frontier), the D1 per-row half over
-- the rollups single-sourced in 082.
--
-- The pre-formatted DISPLAY strings stay hand-authored over these derived structured columns (D3 —
-- display formatting is out of the framework AST, so they carry no TS twin): `delivery_label` mirrors
-- the retired `plan_delivery` label CASE (over the base status + `dc` counts) and `wave_label` is the
-- 1-based "X/N" string over the `wp` frontier. The wave `bar` glyph stays in the retained
-- `plan_wave_summary` VIEW (059). Base columns stay aliased pass-throughs (so the static pages↔schema
-- contract guard still reads the VIEW's columns), sourced off `plans__tracking`'s re-export of the base
-- `plans.*`; `plans__tracking pl` is the sole top-level FROM.
--
-- The retired intermediate VIEWs `plan_delivery` (061) and `plan_wave_label` (060) were consumed ONLY
-- by `plan_read_model`; this migration folds their derivations/display into the composite and DROPs
-- them. `plan_read_model` is a leaf (no VIEW builds on it) and its output column set is UNCHANGED, so
-- the pages↔schema contract guard and every page binding stay valid. `plans__tracking` is the managed
-- VIEW urban provisions at mount; SQLite does not validate a view body at CREATE time, so this
-- migration (which runs before that mount) is created fine and resolves once the managed VIEW exists.
--
-- Forward-only VIEW redefinition (DROP then CREATE). The runner wraps each file in its own transaction,
-- so this file must NOT contain BEGIN/COMMIT. Numbered after 082.

DROP VIEW IF EXISTS plan_read_model;
DROP VIEW IF EXISTS plan_delivery;
DROP VIEW IF EXISTS plan_wave_label;

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
  CASE WHEN COALESCE((COALESCE(("pl"."derived_status" = 'planning'), 0) OR COALESCE(("pl"."derived_status" = 'dispatched'), 0)), 0) THEN 'active' WHEN COALESCE((COALESCE(("pl"."derived_status" = 'done'), 0) AND COALESCE((CASE WHEN COALESCE(((NOT COALESCE(COALESCE(("pl"."status" = 'done'), 0), 0)) OR COALESCE((COALESCE("dc"."prs_opened", 0) = 0), 0)), 0) THEN NULL WHEN COALESCE((COALESCE("dc"."prs_in_flight", 0) > 0), 0) THEN 'converging' WHEN COALESCE((COALESCE("dc"."prs_merged", 0) = COALESCE("dc"."prs_opened", 0)), 0) THEN 'landed' ELSE NULL END = 'converging'), 0)), 0) THEN 'active' WHEN COALESCE((COALESCE(("pl"."derived_status" = 'done'), 0) AND ("pl"."acknowledged_at" IS NULL)), 0) THEN 'active' WHEN COALESCE(("pl"."derived_status" = 'done'), 0) THEN 'history' ELSE 'history' END AS list_bucket,
  CASE WHEN COALESCE((COALESCE(("pl"."derived_status" = 'done'), 0) AND (NOT COALESCE(COALESCE((CASE WHEN COALESCE(((NOT COALESCE(COALESCE(("pl"."status" = 'done'), 0), 0)) OR COALESCE((COALESCE("dc"."prs_opened", 0) = 0), 0)), 0) THEN NULL WHEN COALESCE((COALESCE("dc"."prs_in_flight", 0) > 0), 0) THEN 'converging' WHEN COALESCE((COALESCE("dc"."prs_merged", 0) = COALESCE("dc"."prs_opened", 0)), 0) THEN 'landed' ELSE NULL END = 'converging'), 0), 0)) AND ("pl"."acknowledged_at" IS NULL)), 0) THEN 1 ELSE 0 END AS ack_open,
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
