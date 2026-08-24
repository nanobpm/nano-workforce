-- Epic-detail wave-state: a merged slice must not read "opened" (drift with the summary bar).
--
-- `plan_wave_tasks` (059) is the per-task display VIEW the Epic-detail "Wave state" grid binds
-- (pages/epic-detail.page.json → `wave-state`). Its `status` column exposed the RAW
-- `plan_tasks.status` verbatim — but nothing writes `plan_tasks.status = 'merged'` when a slice's PR
-- lands: the merge write-path flips `pull_requests.status` (and, for a close-without-merge, the
-- `abandonClosedPr` self-heal flips the task terminal), yet a *merged* PR leaves its `plan_tasks` row
-- frozen at `opened`. So a converged-and-merged slice kept showing Status "opened" in the grid, even
-- as its sibling summary VIEWs (`plan_wave_counts`/`plan_wave_summary`) already counted it `merged`
-- via the PR join. That is exactly the drift AGENTS.md forbids: two sibling VIEWs over the same join
-- disagreeing on whether a slice is merged.
--
-- Fix by DERIVING the displayed status the SAME way the count VIEWs bucket `merged` (082): a task is
-- `merged` iff its PR reached `pull_requests__tracking.derived_status = 'merged'` (the terminal-folded
-- status the canonical runtime reads, ADR-0065), otherwise it falls through to its own
-- `plan_tasks.status`. This keeps the per-task grid and the per-wave summary bar in exact agreement —
-- a single notion of "effective task status", still fully DERIVED with no write-path. `pr_url` /
-- `process_key` link targets are re-exported by the `pull_requests__tracking` VIEW (`p.*`), so the
-- single join now sources both the effective status and the link targets. The "Active" tab filter
-- (`status IN (pending,opened,escalated,waiting-for-lane,blocked)`) therefore drops a merged slice as
-- intended instead of stranding it under "opened".
--
-- Forward-only VIEW redefinition (DROP then CREATE); a merged VIEW is not editable in place. The
-- runner wraps each file in its own transaction, so this file must NOT contain BEGIN/COMMIT. Kept a
-- plain `CREATE VIEW … AS SELECT … FROM …` (no CTE / no select-list subquery) so the static
-- pages↔schema contract guard (scripts/pages-contract.test.ts) still parses it. Numbered after 083.

DROP VIEW IF EXISTS plan_wave_tasks;

CREATE VIEW plan_wave_tasks AS
SELECT
  t.id AS id,
  t.plan_key AS plan_key,
  t.task_index AS task_index,
  t.task_id AS task_id,
  t.title AS title,
  t.prompt AS prompt,
  CASE WHEN p.derived_status = 'merged' THEN 'merged' ELSE t.status END AS status,
  t.pr_key AS pr_key,
  t.summary AS summary,
  t.created_at AS created_at,
  t.updated_at AS updated_at,
  t.wave AS wave,
  t.open_question AS open_question,
  t.answer AS answer,
  t.draft_pr_key AS draft_pr_key,
  t.corr_key AS corr_key,
  p.url AS pr_url,
  p.process_key AS process_key
FROM plan_tasks t
LEFT JOIN pull_requests__tracking p ON p.pr_key = t.pr_key;
