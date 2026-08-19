-- 049_drop_feature_escalation_surface.sql — issue #332: the destructive CONTRACT phase of #305,
-- whose EXPAND half landed in #310 (the append-only `feature_escalations` audit table + dual-write +
-- the native `user_tasks` read). Now that escalation/blocked state is projected onto `user_tasks`
-- from the engine's open user tasks (`pollUserTasks` reads the engine directly, like the plan/PR
-- kinds), and the question text survives on `feature_escalations`, the denormalised
-- `feature_runs.escalation_*` / `blocked_user_task_key` surface is dead — nothing reads or writes it.
-- Drop it.
--
-- These four columns were the interim mirror the retired `pollFeatureEscalations` / `pollFeatureBlocked`
-- pollers and the bespoke `answer-escalation` / `acknowledge-blocked` doors used to drive the Feature /
-- Overview pages before the Tasks inbox owned every human decision:
--   • escalation_question       (031) — now sourced from the `feature_escalations` audit log.
--   • escalation_user_task_key  (031) — now read live from the engine's open `feature-escalation` task.
--   • blocked_user_task_key     (032) — now read live from the engine's open `feature-blocked` task.
--   • escalation_open           (040) — the fail-closed torn-tuple display signal, moot once the tuple
--                                       is gone; the Feature page no longer gates any affordance on it.
--
-- Forward-only and numbered after the current highest prefix on origin/main (048); migrations apply in
-- order and are auto-applied on boot. The runner wraps each file in its own transaction, so this file
-- must NOT contain BEGIN/COMMIT. No index references these columns (none was ever created), so a plain
-- `ALTER TABLE … DROP COLUMN` suffices (mirrors 027's `pull_requests`/`plans` pointer drops).
ALTER TABLE feature_runs DROP COLUMN escalation_question;
ALTER TABLE feature_runs DROP COLUMN escalation_user_task_key;
ALTER TABLE feature_runs DROP COLUMN blocked_user_task_key;
ALTER TABLE feature_runs DROP COLUMN escalation_open;
