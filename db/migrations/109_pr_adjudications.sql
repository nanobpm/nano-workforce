-- 109_pr_adjudications.sql — issue #806: persist wait-answer human adjudications so an
-- already-answered convergence question does not re-escalate.
--
-- The convergence loop's `wait-answer` escalation (`record-answer` → resume) applies a human's
-- answer to the CURRENT round but keeps NO durable memory that "(this PR, this question) was already
-- adjudicated to X". A stateless later round that re-derives the identical escalation condition
-- re-parks a human from scratch (PR #800 / proc 46310: the same design question escalated at round 2
-- and again at round 13, both answered identically). A human adjudication is NOT GitHub-derivable —
-- it is a fact the app itself must remember — so it lives here, durably.
--
-- One row per (PR, question) a human has settled: `pr.answer-escalation` (record-answer) writes it on
-- answering, and the poller (`pollUserTasks`) reads it before surfacing a NEW `wait-answer` — when the
-- question's fingerprint matches an existing row it auto-resumes with the recorded answer (attributed
-- to the prior adjudicator) instead of re-escalating a human.
--
--   • question_fingerprint — the canonical `normalizeAdvisoryText` + `fingerprint` digest of the
--     escalation question (app/github.ts `questionFingerprint`), the SAME line-stable normalisation
--     advisory acks use; so only a byte/semantic-identical, already-answered question is suppressed
--     while a materially different question still escalates. No second fingerprint implementation.
--   • answer / adjudicated_by / adjudicated_kind / adjudicated_at — the settled answer, who settled it,
--     whether they were a `human` or an `agent` (ADR 0046), and when, so the auto-resume replays the
--     exact decision AND preserves the original attribution kind — a human-settled decision replays as
--     human, an agent-settled one as agent, so an auto-apply can never launder an agent decision into an
--     irreversible human authority (Copilot review of #806).
--   • invalidated_at — a TOMBSTONE set when a human REVERTS the auto-applied completion that replayed
--     this decision (`revertAgentCompletion` → `invalidateAdjudication`, Copilot review of #806). A plain
--     DELETE is NOT race-safe: the reverted completion's `record-answer` job can be redelivered
--     (at-least-once) AFTER the delete and re-insert the SAME `(pr_key, question_fingerprint)`, so the
--     next poller pass re-auto-applies and silently undoes the revert. Keeping the row as a tombstone lets
--     the `UNIQUE (pr_key, question_fingerprint)` fence make that redelivered re-insert a no-op, and
--     `matchAdjudication` skips a tombstoned row so it never auto-applies again. The tombstone is cleared
--     only by `resetAdjudications` on a fresh-run re-submit. NULL for a live, replayable decision.
--   • source_completion_id — the `task_completions.id` of the WINNING completion that produced this
--     decision (issue #806 review). A FIRST-HAND agent answer to a `wait-answer` records its own durable
--     adjudication (`adjudicated_kind="agent"`) but — unlike a machine auto-apply — its ledger row has
--     `auto_applied=0` and NO `source_adjudication_id`, so a human revert of that reversible agent
--     completion could not previously find and tombstone the decision it created, and the poller would
--     re-auto-apply the reverted answer. Linking every convergence adjudication to its winning completion
--     lets `revertAgentCompletion` invalidate the decision on ANY reversible agent revert, not only a
--     machine replay (`invalidateAdjudicationByCompletion`). INSERT-if-absent, so only the ORIGINAL
--     first-hand completion is recorded; a later auto-apply's re-record is a UNIQUE no-op that leaves the
--     link pointing at the first-hand winner. NULL for a legacy/uncorrelated answer.
--
-- `UNIQUE (pr_key, question_fingerprint)` keeps one settled answer per (PR, question); the surrogate
-- `id` PK gives the `Table<T>` gateway a single-column key. Forward-only, additive (expand). Numbered
-- after the current highest committed prefix (104) in the pre-assigned 109–110 block (#806); the
-- runner wraps each file in its own transaction, so this file must NOT contain BEGIN/COMMIT.
CREATE TABLE IF NOT EXISTS pr_adjudications (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_key               TEXT NOT NULL REFERENCES pull_requests(pr_key),
  question_fingerprint TEXT NOT NULL,
  answer               TEXT,
  adjudicated_by       TEXT,
  adjudicated_kind     TEXT,
  adjudicated_at       TEXT NOT NULL,
  invalidated_at       TEXT,
  source_completion_id INTEGER,
  UNIQUE (pr_key, question_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_pradj_pr ON pr_adjudications(pr_key);
CREATE INDEX IF NOT EXISTS idx_pradj_srccompletion ON pr_adjudications(source_completion_id);
