-- Feature-run `attention` badge: derive it from engine truth (an OPEN native user task), not from the
-- drift-prone `status` variable (issue #422 — the L1 surface closure #439 named but did not ship).
--
-- 073_feature_read_model.sql retired the WRITE-TIME display projection (L2) into this VIEW, but it
-- still derived `attention` from the row's own `status` column:
--     WHEN fr.status = 'awaiting_operator' THEN 'blocked'
--     WHEN fr.status = 'escalated'         THEN '⚠'
-- `status` is a process-scope variable set imperatively by the workers on the happy path. The `feature`
-- process loops the answer arm (`w_answerLoop`, resolution="answer") straight back into `implement-task`
-- with NO reset step, so after an escalation is ANSWERED the token is ACTIVE again at `implement-task`
-- while `status` still reads the previous iteration's `"escalated"` until the re-running agent job
-- completes and overwrites it (issue #422, observed live on merlin: feature instance 31779 showing ⚠
-- on Overview though its escalation was resolved and it was back implementing). Deriving the badge from
-- that sticky value makes the read model LIE — the exact "projected state maintained imperatively at
-- write time" defect class #439 set out to close ("derive it, don't maintain it — No Drift Surfaces").
--
-- The authoritative "who is waiting on a human" set is NOT `status` — it is the `user_tasks` inbox
-- (034_user_tasks_inbox.sql): `pollUserTasks` (app/service.ts) reconciles exactly one row per CURRENTLY
-- OPEN escalation user task from the engine and DELETES the row the moment the task closes (answered
-- here, via the Tasks inbox, or out-of-band). So a run is:
--   * awaiting an operator (blocked glyph) IFF an open `feature-blocked`     user task exists for it, and
--   * escalated            (⚠     badge)  IFF an open `feature-escalation`   user task exists for it.
-- Deriving `attention` from that presence (engine truth) instead of `status` closes the surface: once
-- the escalation is answered the `user_tasks` row is gone, so ⚠ clears immediately REGARDLESS of the
-- stale `status`. There is no stored column and no write path any writer can leave stale — the badge is
-- a pure function of the live open-task set, recomputed on every read. `deriveStage` (app/stage.ts)
-- remains the canonical TS oracle: it now takes the same open-task signals, and
-- app/featureReadModel.test.ts pins the VIEW to it in lockstep over the full status × open-task matrix
-- (including the #422 case: status='escalated' with NO open task → attention NULL).
--
-- pollUserTasks keys these rows `subject_type='feature'`, `subject_key=<feature_key>` (app/service.ts
-- DEFAULT_SUBJECT_TYPE / contextFor), so the correlated match is on `fr.feature_key`. `stage` is
-- deliberately UNCHANGED — an escalated/awaiting_operator run maps to `Implementing`, which is correct
-- whether or not the flag is stale (a run back at `implement-task` IS implementing); only the attention
-- badge was drifting, so only it moves to engine-truth derivation.
--
-- Forward-only, non-additive to `feature_runs` (a VIEW redefinition): `DROP VIEW` then `CREATE VIEW`.
-- 073 is a MERGED, IMMUTABLE migration — never edited; this is a NEW migration that supersedes its VIEW
-- definition. `user_tasks` (034) already exists earlier in the chain, so the correlated subquery
-- resolves. A single plain `CREATE VIEW … SELECT … FROM feature_runs fr` (the `user_tasks` lookups are
-- nested EXISTS subqueries at paren depth ≥ 1, so `feature_runs fr` stays the sole top-level FROM and
-- every output column stays aliased — the static pages↔schema contract guard, scripts/pages-contract.
-- test.ts, still parses the projection). Numbered after the current highest prefix on origin/main (074).
-- The runner wraps each file in its own transaction, so this file must NOT contain BEGIN/COMMIT.

DROP VIEW IF EXISTS feature_read_model;

CREATE VIEW feature_read_model AS
SELECT
  fr.feature_key AS feature_key,
  fr.repo AS repo,
  fr.issue_number AS issue_number,
  fr.issue_url AS issue_url,
  fr.title AS title,
  fr.base_branch AS base_branch,
  fr.status AS status,
  fr.process_key AS process_key,
  fr.pr_key AS pr_key,
  fr.converge AS converge,
  fr.auto_merge AS auto_merge,
  fr.outcome AS outcome,
  fr.delivery_label AS delivery_label,
  fr.acknowledged_at AS acknowledged_at,
  fr.created_at AS created_at,
  fr.updated_at AS updated_at,
  (CASE
    WHEN fr.status IN ('merged', 'converged', 'blocked', 'failed', 'skipped', 'abandoned') THEN 'Done'
    WHEN fr.status = 'converging' THEN 'Converging'
    WHEN (fr.pr_key IS NOT NULL AND fr.pr_key <> '') OR fr.status = 'opened' THEN 'PR open'
    WHEN fr.status IN ('running', 'escalated', 'awaiting_operator') THEN 'Implementing'
    ELSE 'Requested'
  END) AS stage,
  (CASE
    WHEN fr.status IN ('merged', 'converged') THEN 'ok'
    WHEN fr.status = 'blocked' THEN 'blocked'
    WHEN fr.status IN ('failed', 'skipped', 'abandoned') THEN 'failed'
    ELSE NULL
  END) AS stage_state,
  (CASE
    WHEN NOT (fr.converge IS NOT NULL AND fr.converge <> 0) THEN 'Converging Merging'
    WHEN NOT (fr.auto_merge IS NOT NULL AND fr.auto_merge <> 0) THEN 'Merging'
    ELSE ''
  END) AS stage_skipped,
  (CASE
    WHEN EXISTS (
      SELECT 1 FROM user_tasks ut
      WHERE ut.subject_type = 'feature' AND ut.subject_key = fr.feature_key
        AND ut.element_id = 'feature-blocked'
    ) THEN 'blocked'
    WHEN EXISTS (
      SELECT 1 FROM user_tasks ut
      WHERE ut.subject_type = 'feature' AND ut.subject_key = fr.feature_key
        AND ut.element_id = 'feature-escalation'
    ) THEN '⚠'
    ELSE NULL
  END) AS attention,
  (CASE
    WHEN fr.status IN ('merged', 'converged', 'blocked', 'failed', 'skipped', 'abandoned') AND fr.acknowledged_at IS NOT NULL THEN 'history'
    ELSE 'active'
  END) AS list_bucket
FROM feature_runs fr;
