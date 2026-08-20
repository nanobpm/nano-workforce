-- Contract phase for the escalation scope-override columns (migration 056, issue #395).
--
-- Migration 056 added `escalations.head_sha` + `escalations.scope_block` to give the DETERMINISTIC
-- scope-integrity gate a human-override door: it bound a scope escalation to the reviewed HEAD so a
-- same-HEAD human answer could override the block instead of re-escalating forever. That whole
-- deterministic gate has since been replaced by the `senior:scope-classify` AGENT classifier, which
-- reads each closed issue's acceptance criteria and honours the recorded human `answer` directly —
-- so nothing writes or reads these two columns any more. They are dead schema (a drift surface with
-- no source of truth behind them), so drop them.
--
-- 056 is forward-only and immutable (its ledger row stays), so this is the standard expand→contract
-- follow-up rather than an edit to 056. Both drops are safe: the columns were nullable/defaulted and
-- have no remaining writer or reader. Numbered after the current highest prefix (056); the runner
-- wraps each file in its own transaction, so this file must NOT contain BEGIN/COMMIT.
ALTER TABLE escalations DROP COLUMN scope_block;
ALTER TABLE escalations DROP COLUMN head_sha;
