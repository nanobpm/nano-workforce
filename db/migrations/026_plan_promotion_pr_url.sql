-- Epic "ready to promote" foundations (issue #160). An epic that lands on a long-lived integration
-- branch (`base_branch`, 019_plan_base_branch.sql) reaches the repository default branch only when
-- that branch is deliberately merged. These two columns model the one-click, human-gated
-- integration→default-branch promotion:
--   • `promotion_pr_url` — the promotion PR (integration branch → default branch) once opened by the
--     promoteEpic operation. NULL until promoted; set to the PR url makes the promotion idempotent.
--   • `promote_ready` — denormalised read-model signal the epic pages badge/gate on. 1 (ready)
--     exactly when the plan is `done`, has a `base_branch`, and has no `promotion_pr_url` yet;
--     otherwise NULL (nullable, not 0). NULL — not 0 — because the epics-overview badge column
--     renders whenever the field stringifies non-empty (`String(value).trim() !== ""`), so a 0 would
--     paint the ↑ badge on every non-ready row; NULL stringifies to "" and is gated out, while the
--     detail-page `showWhenField` truthiness gate treats NULL and 0 identically (#160, #174). Stored
--     (not a SQL view) because the epic pages read the `plans` table directly, mirroring `wave_label`
--     / `open_plan_findings`. The per-row default-branch check (base_branch == repo default) is
--     deliberately deferred to the promoteEpic operation — too costly/async for the read path.

ALTER TABLE plans ADD COLUMN promotion_pr_url TEXT;
ALTER TABLE plans ADD COLUMN promote_ready INTEGER;
