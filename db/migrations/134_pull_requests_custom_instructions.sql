-- Durable operator-steering projection for /status (issue #956). `startConvergenceLoop` accepts an
-- optional `customInstructions` string that is appended to EVERY converge round's agent prompt
-- (review-round + adversarial-review) via their `appendPrompt` FEEL. So the operator can SEE that a
-- loop is being steered without an engine read, the writer that already knows — `submitPr`
-- (submit/reopen) — stamps `custom_instructions` (1|0) on the row, and `/status` serves it as
-- `hasCustomInstructions`. Run-scoped: the atomic reopen resets it to the fresh run's steering.
-- `custom_instructions` is NULL on every pre-#956 row; those legacy rows read as false.
ALTER TABLE pull_requests ADD COLUMN custom_instructions INTEGER;
