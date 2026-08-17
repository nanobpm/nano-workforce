-- 039_feature_pipeline_stage.sql — issue #254 §1/§5: reify the feature-run pipeline stage and the
-- Active/History tick-off partition as derived, write-time-projected columns, so the declarative
-- Feature view can render an intent-first pipeline track and a Done tick-off with only stored
-- `{"field":…}` bindings and flat `in` filters (the dataGrid page DSL has no OR / IS NULL / TS
-- callback). These mirror the existing `delivery_label` / `epic_phase` display projections: each is
-- maintained by the feature_runs gateway (app/feature.ts) from the pure `deriveStage` helper
-- (app/stage.ts) on every write — never hand-derived in SQL, the page, or a poller.
--
-- Columns:
--   • acknowledged_at — NULL until an operator dismisses a terminal run (§5, acknowledge-done).
--   • stage           — deriveStage(...).stage: Requested|Implementing|PR open|Converging|Merging|Done
--                       (the page's pipeline column binds `activeField` to it).
--   • stage_state     — deriveStage(...).state: ok|failed|blocked|NULL (bound to `stateField`).
--   • stage_skipped   — deriveStage(...).skipped: space-separated not-in-path stage keys (`notInPathField`).
--   • attention       — deriveStage(...).attention: short badge text or NULL (`badgeField`).
--   • list_bucket     — 'active' | 'history': history iff terminal AND acknowledged, else active
--                       (Active = live + terminal-but-unacknowledged; History = acknowledged terminals).
--
-- Forward-only, additive (expand): all nullable with no default, so pre-#254 rows grandfather in as
-- NULL and never gate control flow. `backfillFeatureStages` (app/feature.ts) stamps legacy rows once
-- at boot, and the gateway keeps every future write fresh. Numbered after the current highest prefix
-- on origin/main (038); the runner wraps each file in its own transaction, so this file must NOT
-- contain BEGIN/COMMIT.
ALTER TABLE feature_runs ADD COLUMN acknowledged_at TEXT;
ALTER TABLE feature_runs ADD COLUMN stage TEXT;
ALTER TABLE feature_runs ADD COLUMN stage_state TEXT;
ALTER TABLE feature_runs ADD COLUMN stage_skipped TEXT;
ALTER TABLE feature_runs ADD COLUMN attention TEXT;
ALTER TABLE feature_runs ADD COLUMN list_bucket TEXT;
