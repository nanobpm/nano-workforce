-- Epic "ready to promote" foundations (issue #160). An epic that lands on a long-lived integration
-- branch (`base_branch`, 019_plan_base_branch.sql) reaches the repository default branch only when
-- that branch is deliberately merged. These two columns model the one-click, human-gated
-- integration→default-branch promotion:
--   • `promotion_pr_url` — the promotion PR (integration branch → default branch) once opened by the
--     promoteEpic operation. NULL until promoted; set to the PR url makes the promotion idempotent.
--   • `promote_ready` — denormalised read-model signal the epic pages badge/gate on. TRUE (1) exactly
--     when the plan is `done`, has a `base_branch`, and has no `promotion_pr_url` yet. Stored (not a
--     SQL view) because the epic pages read the `plans` table directly, mirroring `wave_label` /
--     `open_plan_findings`. The per-row default-branch check (base_branch == repo default) is
--     deliberately deferred to the promoteEpic operation — too costly/async for the read path.

ALTER TABLE plans ADD COLUMN promotion_pr_url TEXT;
ALTER TABLE plans ADD COLUMN promote_ready INTEGER NOT NULL DEFAULT 0;
