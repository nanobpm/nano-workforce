-- Denormalise the engine `form_key` onto the unified Tasks-inbox read-model (issue #461) — additive,
-- nullable. The collapsed Tasks page renders ONE `user_tasks` grid and completes each heterogeneous row
-- via its ENGINE-declared form (nano-ide#457's `detail.engineForm`), instead of seven
-- `element_id`-allowlisted grids each with a hand-authored `detail.form` copy of a deployed `.form`.
-- Rendering the deployed form per row needs the task's engine `formKey` on the row, so the grid can
-- resolve `GET /app/actions/form?formKey=<row.form_key>` — the SAME single source of truth
-- `taskInbox` uses (no page-local field duplication).
--
-- Derived in the canonical poller path exactly as `kind_label` is (no drift surface): `pollUserTasks`
-- (app/service.ts) reads the engine-resolved `formKey` from the Camunda `/v2/user-tasks/search` result
-- and `buildUserTaskRow` (app/userTasks.ts) writes it, falling back to the fixed-form kinds' static
-- `.form` linkage (`ESCALATION_FORM_BY_ELEMENT`, app/agentCompletion.ts) when the search omits it.
-- NULL when neither resolves — the grid degrades to bare completion, matching `taskInbox`.
--
-- Forward-only, additive (expand): a new nullable column on an existing table, no shape rewrite and no
-- backfill (the poller repopulates every open row on its next pass). Numbered after the current highest
-- prefix (076); the runner wraps each file in its own transaction, so this file must NOT contain
-- BEGIN/COMMIT.
ALTER TABLE user_tasks ADD COLUMN form_key TEXT;

-- The collapsed Tasks page reads `user_tasks` UNFILTERED ordered by `updated_at desc` (pages/tasks.page.json),
-- an access pattern the existing composite indexes (`(element_id, updated_at)`, `(subject, element_id)`) can't
-- serve — SQLite would scan + sort the whole table as the inbox grows. Front the unified inbox's sort with a
-- single-column index on `updated_at`. Additive and idempotent.
CREATE INDEX IF NOT EXISTS idx_user_tasks_updated ON user_tasks(updated_at);
