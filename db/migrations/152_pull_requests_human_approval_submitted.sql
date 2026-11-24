-- The human-approval SETTING a PR run was submitted with (issue #1054 review). `merge_human_approval`
-- is the OUTSTANDING-approval state (cleared to 0 on approve and by `startMerge`), and the loop's
-- `humanApproval` variable is cleared the same way, so neither can answer "was this run submitted
-- with humanApproval?" once approval was given. `submitPr` stamps this at submit/reopen; nothing
-- clears it. Run-scoped: the atomic reopen rewrites it. NULL on pre-existing rows (unknown).
ALTER TABLE pull_requests ADD COLUMN human_approval_submitted INTEGER;
