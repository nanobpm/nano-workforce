-- 043_pr_epic_phase.sql — issue #304: surface epic / cross-slice lineage on the Convergence
-- PR-row detail. An operator triaging a PR (especially an escalation) needs to see, at the point of
-- decision, that the PR is a slice of an epic and which phase that epic is in — without navigating to
-- the Lineage page. The sibling-slice roster is already expressible in page JSON today (a `plan_tasks`
-- child grid joined `pull_requests.root_request_key → plan_tasks.plan_key`), but the epic's PHASE
-- lives on `plans.epic_phase` (038) / `lineage_threads.stage_label` (037), NOT on `pull_requests`, so
-- a `detail.field` cannot read it directly.
--
-- This migration adds the one missing projection column the read model needs:
--
--   • `pull_requests.epic_phase_label` — the parent epic's phase label for an epic slice PR (e.g.
--     "Implementing (wave 3/5)"), NULL for a feature/self-rooted PR that is not an epic slice.
--     Written idempotently on the SAME lineage poll path that maintains the lineage projection
--     (`app/lineage.ts` `pollLineage` → `projectEpicPhaseLabels`), mirroring the existing write-time
--     projection convention (`plans.epic_phase`, `plans.delivery_label`, `feature_runs.delivery_label`).
--     The poller prefers the epic's stamped `epic_phase`, falling back to the thread's delivery-rollup
--     stage label for a grandfathered epic that never stamped one, and clears the column to NULL if a
--     PR is ever re-rooted off an epic — so no stale epic label can survive.
--
-- Forward-only, additive (expand): a nullable TEXT column with no default, display-only, that never
-- gates control flow. Numbered after the current highest prefix (042). The runner wraps each file in
-- its own transaction, so this file must NOT contain BEGIN/COMMIT.
ALTER TABLE pull_requests ADD COLUMN epic_phase_label TEXT;

-- Backfill pre-existing rows so the epic panel is populated at deploy time, not only after the first
-- poll pass writes it. An epic slice PR is one whose `root_request_key` is an epic `plans.plan_key`
-- (submitPr threads the epic origin key onto every slice PR, and migration 037 backfilled legacy
-- rows the same way); stamp it with that epic's `plans.epic_phase`. A feature/self-rooted PR has no
-- matching plan, so it stays NULL — no empty epic panel for a non-epic PR. Idempotent, and the poller
-- reconciles the delivery-rollup fallback (for a plan whose `epic_phase` is NULL) on its next pass.
UPDATE pull_requests SET epic_phase_label = (
    SELECT p.epic_phase FROM plans p WHERE p.plan_key = pull_requests.root_request_key
  )
  WHERE EXISTS (
    SELECT 1 FROM plans p WHERE p.plan_key = pull_requests.root_request_key
  );
