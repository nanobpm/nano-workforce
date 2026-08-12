-- Durable "needs attention" resolution for the trial-merge audit log (issue: the
-- epic page's "Needs attention" tab never cleared).
--
-- `plan_trial_merges` is an append-only audit trail: a re-run after a suite
-- failure INSERTs a fresh row but never supersedes the old red one, so a
-- `merge-conflict`/`suite-failed` row stayed in "Needs attention" forever even
-- after the escalation was answered and the wave re-run clean. Add an explicit
-- `resolved` flag so the page can hide history, and backfill it for existing
-- rows. Going forward `recordTrialMergeAudit` marks prior same-(plan,wave) rows
-- resolved on each new insert (supersede-on-insert).
--
-- NB: the migration runner wraps each file in its own transaction — this file
-- must NOT contain BEGIN/COMMIT.

ALTER TABLE plan_trial_merges ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0;

-- Backfill 1 (supersede): any audit row that has a NEWER row (higher id) for the
-- same (plan_key, wave) is superseded history — resolve it. The newest row per
-- wave stays unresolved so a still-red latest attempt keeps showing.
UPDATE plan_trial_merges
SET resolved = 1
WHERE EXISTS (
  SELECT 1 FROM plan_trial_merges AS newer
  WHERE newer.plan_key = plan_trial_merges.plan_key
    AND newer.wave = plan_trial_merges.wave
    AND newer.id > plan_trial_merges.id
);

-- Backfill 2 (answered): a red (needs-attention) row whose trial escalation has
-- already been answered is resolved — even if no re-run row was ever recorded
-- (e.g. the operator answered "proceed"/override). The trial escalation's
-- task_id is 'trial-merge-wave-<wave>' (see app/trialMerge.ts trialMergeTaskId).
UPDATE plan_trial_merges
SET resolved = 1
WHERE result IN ('merge-conflict', 'suite-failed')
  AND EXISTS (
    SELECT 1 FROM plan_escalations AS e
    WHERE e.plan_key = plan_trial_merges.plan_key
      AND e.task_id = 'trial-merge-wave-' || plan_trial_merges.wave
      AND e.status = 'answered'
  );

CREATE INDEX IF NOT EXISTS idx_plan_trial_merges_attention
  ON plan_trial_merges(plan_key, resolved, result);
