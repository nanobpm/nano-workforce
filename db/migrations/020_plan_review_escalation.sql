-- Plan-review cap escalation. When the adversarial review loop exhausts its per-epoch budget
-- without approval, the plan-fanout process parks for a human directive instead of raising an
-- unhandled PLAN_REJECTED incident. A `revise` answer starts a new review epoch; a `proceed`
-- answer explicitly dispatches the current plan as-is.
--
-- `plan_reviews.round` remains derived from the append-only review log, but now within the current
-- epoch. SQLite cannot alter the existing PRIMARY KEY (plan_key, round), so recreate the table with
-- (plan_key, epoch, round) and backfill existing rows into epoch 0.

ALTER TABLE plan_reviews ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0;

CREATE TABLE plan_reviews_new (
  plan_key    TEXT NOT NULL REFERENCES plans(plan_key),
  epoch       INTEGER NOT NULL DEFAULT 0,
  round       INTEGER NOT NULL,
  approved    INTEGER NOT NULL,
  findings    TEXT,
  created_at  TEXT NOT NULL,
  job_key     TEXT,
  PRIMARY KEY (plan_key, epoch, round)
);

INSERT INTO plan_reviews_new (plan_key, epoch, round, approved, findings, created_at, job_key)
SELECT plan_key, epoch, round, approved, findings, created_at, job_key
FROM plan_reviews;

DROP TABLE plan_reviews;
ALTER TABLE plan_reviews_new RENAME TO plan_reviews;

CREATE INDEX idx_plan_reviews_plan ON plan_reviews(plan_key);
CREATE UNIQUE INDEX idx_plan_reviews_job ON plan_reviews(plan_key, job_key);

CREATE TABLE plan_review_escalations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_key     TEXT NOT NULL REFERENCES plans(plan_key),
  epoch        INTEGER NOT NULL,
  round        INTEGER NOT NULL,
  findings     TEXT,
  status       TEXT NOT NULL,              -- open | answered
  directive    TEXT,                       -- proceed | revise (answered rows only)
  note         TEXT,
  asked_at     TEXT NOT NULL,
  answered_at  TEXT
);

CREATE INDEX idx_plan_review_escalations_plan ON plan_review_escalations(plan_key);
CREATE INDEX idx_plan_review_escalations_open ON plan_review_escalations(plan_key, status);

ALTER TABLE plans ADD COLUMN open_plan_escalation_id INTEGER;
ALTER TABLE plans ADD COLUMN open_plan_findings TEXT;
ALTER TABLE plans ADD COLUMN open_plan_round INTEGER;
