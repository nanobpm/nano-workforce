-- Conformance review — escalation instance tracking (issue #216).
--
-- When conformance finds the epic did NOT cleanly meet its spec (a reduced / not-verified item, or a
-- deviation nobody raised), it escalates to the Tasks inbox as a NON-BLOCKING follow-up: the `retro`
-- process parks on a native `conformance-escalation` user task until an operator acknowledges it.
--
-- The unified inbox (`user_tasks`, 034) is reconciled by `pollUserTasks`, which scans the open user
-- tasks of each *instance-tracked* aggregate (feature_runs / plans / pull_requests). The retro process
-- had no such tracking, so its user task was invisible to the inbox. These two columns make
-- `plan_conformance` the retro run's tracking row: `process_key` is the retro process instance, and
-- `review_status` is its escalation lifecycle — `reviewing` while the ack task is open (the poller
-- scans these), `reviewed` once the run settles (set by `record-conformance` when there is nothing to
-- escalate, by the `pr.conformance-ack` worker (`acknowledgeConformance`) when an operator
-- acknowledges the escalation and the retro instance COMPLETES normally, and — as a crash/cancel
-- safety net — by `instanceTracking.onTerminated` when the retro instance is TERMINATED rather than
-- completing).
--
-- Forward-only, additive (expand): two nullable/defaulted columns on the table 052 just added; the
-- runner wraps each file in its own transaction, so this file must NOT contain BEGIN/COMMIT.
ALTER TABLE plan_conformance ADD COLUMN process_key TEXT;
ALTER TABLE plan_conformance ADD COLUMN review_status TEXT NOT NULL DEFAULT 'reviewed';

-- `pollUserTasks` scans open retro escalations by `review_status = 'reviewing'` every poll pass
-- (app/conformance.ts `activeConformanceReviews`). Index it so the common-case status scan stays a
-- cheap lookup instead of a full table scan as conformance rows accumulate — mirrors the
-- `idx_feature_runs_status` precedent (028) for the equivalent status-scanned aggregate.
CREATE INDEX IF NOT EXISTS idx_plan_conformance_review_status ON plan_conformance(review_status);
