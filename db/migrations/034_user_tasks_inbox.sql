-- Unified "Tasks" inbox read-model (issue #236) — surface EVERY open native user-task escalation
-- awaiting a human decision in the nwf UI, so an operator can resolve one without leaving the app.
--
-- The four migrated escalations (ADR 0046) are native BPMN `userTask`s with linked `.form`s:
-- `feature-escalation` (a stuck single-issue run), `feature-blocked` (a blocked run to acknowledge),
-- `plan-review-decision` (a plan-review cap escalation), `trial-merge-decision` (a red trial merge),
-- and the PR review-loop `wait-answer`. The completable user-task keys were only ever denormalised
-- for the FEATURE kinds (migrations 031/032, onto `feature_runs`); the epic/PR kinds had NO app-side
-- pointer at all, so the only surface that listed them was Urban's read-only `taskInbox` stub.
--
-- This is the schema-driven pages' single source for the Tasks page `dataGrid`s: `pollUserTasks`
-- (app/service.ts) reconciles one row per currently-open escalation user task from the engine
-- (`searchUserTasks`), denormalising the completable `user_task_key` plus display context (the
-- escalation `question`, its `subject_*`, and `element_id`). A row exists iff the user task is open;
-- the poller deletes a row once its task is gone (answered here, via the task inbox, or out-of-band),
-- so `showCount` reflects live pending work. The completion affordances post the typed form variables
-- to the canonical human completer (`completeEscalationAsHuman` / the existing feature answer/ack
-- operations), the same resume path the task inbox uses — no parallel completion.
--
-- Forward-only, additive (expand): a brand-new table, no existing shape touched. Numbered after the
-- current highest prefix (033); the runner wraps each file in its own transaction, so this file must
-- NOT contain BEGIN/COMMIT.
CREATE TABLE user_tasks (
  -- The completable native user-task key (the engine's `userTaskKey`) — the PK, since a user task is
  -- open at most once and every completion affordance posts to it.
  user_task_key TEXT PRIMARY KEY,
  -- The BPMN `elementId` of the parked user task (one of the migrated escalation elements). Drives
  -- which typed decision form / completion operation the page routes the answer through.
  element_id    TEXT NOT NULL,
  -- Human-readable kind label for the grid (e.g. "Plan review", "Trial merge").
  kind_label    TEXT NOT NULL,
  -- The domain subject the escalation belongs to: `subject_type` is feature | plan | pr; `subject_key`
  -- is its aggregate key (feature_key / plan_key / pr_key); `subject_url` is an optional external link
  -- (the issue/PR URL) shown as a clickable column.
  subject_type  TEXT NOT NULL,
  subject_key   TEXT NOT NULL,
  subject_url   TEXT,
  -- The escalation question / findings the agent (or loop) raised, denormalised for display so the
  -- operator can decide without opening the process. Best-effort; NULL when none was recorded.
  question      TEXT,
  -- The owning process instance key, for the process-explorer link. NULL when unknown.
  process_key   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- The pages filter the grid by `element_id` (one grid per kind) and order by recency
-- (`WHERE element_id IN (...) ORDER BY updated_at DESC`). A single composite index on
-- `(element_id, updated_at)` serves both the equality filter and the ordered read in one structure —
-- no extra sort/scan — so the read stays O(matching), not O(all open tasks), as the table grows.
CREATE INDEX idx_user_tasks_element_updated ON user_tasks(element_id, updated_at);
