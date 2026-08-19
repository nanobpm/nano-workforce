-- 043_epic_set_admission_staging.sql — issue #292 slice S2: durable ADMISSION STAGING for the
-- set/batch door (`startEpicSet`).
--
-- S2 is the admission DOOR + DAG validator only; it deliberately does NOT start any epic and does
-- NOT materialize the durable plan graph. Slice S3 (planner lowering: schedule roots, seed the
-- capability gate, bind the resolved version) is the slice that actually CREATES `plans` rows and
-- their `plan_deps` edges — so S3, not S2, is the correct owner of both.
--
-- That split leaves S2 needing to persist WHAT it admitted so a crash between admission and lowering
-- does not lose the set. It cannot write `plan_deps` for that: `plan_deps.plan_key REFERENCES
-- plans(plan_key)` (041), but S2 has not created any `plans` row, so a first-time set submission
-- would FK-fail (500). Nor should it pre-create a `plans` row — a non-terminal `plans` row reads as
-- `alreadyRunning` to the canonical `startPlan`, which would wedge S3 from ever starting it.
--
-- So S2 stages into its OWN, FK-FREE structure here, and S3 reads it during lowering to materialize
-- `plans` + `plan_deps` when it schedules roots (where the FK is satisfied by construction). Neither
-- staging table references `plans` — that is the whole point: the staging is writable BEFORE any
-- plan graph exists.
--
--   • admitted_epics — one row per admitted epic in the set (INCLUDING roots, which carry no edge).
--     `plan_key` is the epic's canonical key; the rest is what S3 needs to materialize the `plans`
--     row (repo, issue number/url, the normalized integration base branch). PRIMARY KEY (plan_key)
--     makes a re-submitted set idempotent (one staged row per epic).
--   • admitted_plan_deps — the FK-FREE staging twin of `plan_deps`: one row per validated inter-epic
--     edge (`plan_key` waits for `depends_on_plan_key`, gated by { package, capability_ref }).
--     Constraints MIRROR plan_deps EXCEPT the FK: PRIMARY KEY (plan_key, depends_on_plan_key) so a
--     re-submitted set cannot duplicate an edge, CHECK (plan_key <> depends_on_plan_key) so no
--     self-edge — but NO `REFERENCES plans(...)`, since neither endpoint's plan row exists yet. The
--     set validator (S2) is what guarantees every endpoint names a submitted epic.
--
-- Numbered after the current highest prefix on origin/main (042_plan_promotion.sql) — the branch
-- forks at 041 while main advanced to 042, so this MUST be 043 to avoid a merge-time prefix
-- collision. The runner wraps each file in its own transaction, so this file must NOT contain
-- BEGIN/COMMIT.

CREATE TABLE admitted_epics (
  plan_key     TEXT NOT NULL PRIMARY KEY,  -- the admitted epic's canonical key (owner/repo#123)
  repo         TEXT NOT NULL,              -- owner/repo the epic issue lives in
  issue_number INTEGER NOT NULL,           -- the epic issue number
  issue_url    TEXT NOT NULL,              -- canonical issue URL (for S3 to materialize the plans row)
  base_branch  TEXT NOT NULL,              -- normalized integration base branch admitPlan resolved
  created_at   TEXT NOT NULL
);

CREATE TABLE admitted_plan_deps (
  plan_key            TEXT NOT NULL,  -- dependent/consumer epic that waits (FK-free: plans may not exist yet)
  depends_on_plan_key TEXT NOT NULL,  -- producer epic it waits for
  package             TEXT NOT NULL,  -- producer's published package name
  capability_ref      TEXT NOT NULL,  -- producer epic issue handle → pkg@version
  created_at          TEXT NOT NULL,
  PRIMARY KEY (plan_key, depends_on_plan_key),
  CHECK (plan_key <> depends_on_plan_key)
);

CREATE INDEX idx_admitted_plan_deps_plan ON admitted_plan_deps(plan_key);
CREATE INDEX idx_admitted_plan_deps_producer ON admitted_plan_deps(depends_on_plan_key);
