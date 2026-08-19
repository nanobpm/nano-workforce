-- 048_feature_escalations.sql — issue #305: canonical, append-only source for a feature run's
-- escalation QUESTION, so the denormalised `feature_runs.escalation_question` column can be dropped
-- in the later CONTRACT phase without losing the text the Tasks inbox shows.
--
-- Today the `feature-escalation` question is denormalised onto `feature_runs.escalation_question`
-- (written by `record-feature-escalation`, read by `pollUserTasks`). #305 consolidates escalation
-- state onto the native `user_tasks` projection and removes the duplicate `feature_runs.escalation_*`
-- surface. The question text still has to come from SOMEWHERE the poller can read while a run is
-- parked — so, exactly like the surviving `plan_reviews` (adversarial plan-review log), `escalations`
-- (PR review-loop log) and `plan_trial_merges` (D3 trial-merge gate log) audit tables that already
-- enrich the plan/PR kinds' questions in `pollUserTasks`, the FEATURE kind gets its own append-only
-- audit log. `record-feature-escalation` appends one row per escalation entry (with the agent's
-- `question`), and the poller reads the newest row per feature as the live question.
--
-- Append-only (never updated/deleted): the newest `id` for a `feature_key` is the current question,
-- mirroring `escalations`/`latestOpenEscalationQuestion`. No "answered" flag is needed for display —
-- `pollUserTasks` already gates the row's existence on the run being parked at an observable task, so
-- the enrichment only supplies the text.
--
-- EXPAND (additive) phase: this only ADDS a table and BACKFILLS the currently-open escalations'
-- questions from `feature_runs`; nothing is dropped and the poller reads it with a fallback to the
-- legacy column, so it is safe to land before the contract phase. Numbered after the current highest
-- prefix on origin/main (047). The runner wraps each file in its own transaction, so this file must
-- NOT contain BEGIN/COMMIT.
CREATE TABLE feature_escalations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  feature_key TEXT NOT NULL,
  question    TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_feature_escalations_feature ON feature_escalations(feature_key, id);

-- Backfill: seed one audit row for every run currently parked at an answerable escalation with a
-- captured question, so a run parked WHEN THIS LANDS keeps showing its question after the poller
-- switches to reading the audit log (the poller's legacy-column fallback covers this too, but the
-- backfill makes the new log authoritative from boot). `escalation_open = 1` is the fail-closed
-- signal (migration 040) that all three legacy columns agree the run is answerable.
INSERT INTO feature_escalations (feature_key, question, created_at)
SELECT feature_key, escalation_question, COALESCE(updated_at, created_at)
FROM feature_runs
WHERE escalation_open = 1 AND escalation_question IS NOT NULL;
