-- Per-plan target base branch (epic base-branch control). When set, the fleet branches off this
-- branch and opens every task PR against it instead of the repository's default branch, so an
-- entire epic can land on a long-lived integration branch (e.g. `epic/agent-protocol`) and reach
-- the default branch — and any merge-to-default side effect such as auto-publishing a package —
-- only when the integration branch is deliberately merged. NULL keeps the legacy behaviour (the
-- repo default branch), so pre-migration plans are unaffected.

ALTER TABLE plans ADD COLUMN base_branch TEXT;
