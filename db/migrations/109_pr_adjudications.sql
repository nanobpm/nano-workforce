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
--   • answer / adjudicated_by / adjudicated_at — the settled answer, who settled it, and when, so the
--     auto-resume replays the exact decision and attributes it to the original adjudicator.
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
  adjudicated_at       TEXT NOT NULL,
  UNIQUE (pr_key, question_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_pradj_pr ON pr_adjudications(pr_key);
