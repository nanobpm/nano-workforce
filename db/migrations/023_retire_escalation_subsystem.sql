-- Retire the bespoke escalation subsystem — the destructive CONTRACT phase of the
-- expand-and-contract migration to native BPMN `userTask` + `.form` (ADR 0002, epic
-- #156). The escalation-conversion slices already stopped WRITING/reading these
-- surfaces (U2 vacated the plan/task/plan-review mirrors; U3 vacated the PR
-- review-loop `open_escalation_*` mirror), deriving open-escalation state from parked
-- user tasks (`searchUserTasks`) instead. Nothing reads these tables/columns any more,
-- so drop them.
--
-- Forward-only and numbered after the current highest prefix (022); migrations apply
-- in order and are auto-applied on boot. The migration runner wraps each file in its
-- own transaction — this file must NOT contain BEGIN/COMMIT.
--
-- NB: the merge-loop escalation (out of scope for #156) still uses the shared
-- `escalations` audit table + the `escalation-answered` message path — those are
-- deliberately KEPT here.

-- 1. The per-task implementation-phase escalation audit table (006_task_escalation.sql).
--    Superseded by the `feature-escalation` user task; its answer now resumes the
--    process directly. DROP TABLE also drops its indexes.
DROP TABLE IF EXISTS plan_escalations;

-- 2. The plan-review cap escalation audit table (020_plan_review_escalation.sql).
--    Superseded by the `plan-review-decision` user task; the review epoch is now the
--    durable process variable `planReviewEpoch`, not the count of answered rows.
DROP TABLE IF EXISTS plan_review_escalations;

-- 3. The denormalised "currently-open escalation" pointers on `pull_requests`
--    (003_open_escalation.sql). The open-escalation question is derived from the
--    canonical `escalations` audit row + parked user tasks — no denormalised pointer.
ALTER TABLE pull_requests DROP COLUMN open_escalation_id;
ALTER TABLE pull_requests DROP COLUMN open_escalation_question;

-- 4. The denormalised per-plan "oldest open task escalation" pointer
--    (006_task_escalation.sql) and the "open plan-review escalation" pointer
--    (020_plan_review_escalation.sql) on `plans`. Both are surfaced from the task
--    inbox (`searchUserTasks`) now, with no denormalised mirror on the plan row.
ALTER TABLE plans DROP COLUMN open_task_escalation_id;
ALTER TABLE plans DROP COLUMN open_task_question;
ALTER TABLE plans DROP COLUMN open_task_corr_key;
ALTER TABLE plans DROP COLUMN open_task_id;
ALTER TABLE plans DROP COLUMN open_plan_escalation_id;
ALTER TABLE plans DROP COLUMN open_plan_findings;
ALTER TABLE plans DROP COLUMN open_plan_round;
