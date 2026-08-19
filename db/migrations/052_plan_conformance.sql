-- Spec-conformance review — the post-completion "did we build what the spec asked for?" stage.
--
-- It rides the same `retro` process that already fires exactly once when an epic's LAST PR reaches
-- a terminal state (see 016_plan_retro.sql / app/retro.ts). Before the retro agent distils lessons,
-- a `senior:conformance` agent EXAMINES THE ACTUAL IMPLEMENTATION — it reads the delivered PR diffs,
-- the code, and the tests (not just what agents claimed) — and checks each item of the spec (the
-- epic issue + every slice's `prompt`) against what was really shipped. It posts a conformance
-- report as a comment on the epic issue and emits per-item acceptance verdicts plus the two classes
-- of deviation: those RAISED during implementation (`scope-change` blackboard entries) and those it
-- found itself that were NEVER raised. This table records that result.
--
-- Advisory, like the retro it accompanies: it gates no delivery control flow (the epic already
-- merged). One row per epic, keyed on plan_key.
CREATE TABLE plan_conformance (
  plan_key             TEXT PRIMARY KEY REFERENCES plans(plan_key),
  status               TEXT NOT NULL,               -- filed | skipped | blocked (the agent's result status)
  comment_url          TEXT,                         -- the conformance report comment the agent posted on the epic issue, or NULL
  slices_met           INTEGER NOT NULL DEFAULT 0,  -- items fully delivered as specified
  slices_reduced       INTEGER NOT NULL DEFAULT 0,  -- items delivered in a reduced/partial form
  slices_not_verified  INTEGER NOT NULL DEFAULT 0,  -- items the agent could not confirm from the implementation (e.g. no live wiring / synthetic only)
  deviations_raised    INTEGER NOT NULL DEFAULT 0,  -- scope deviations agents flagged during implementation (`scope-change` entries)
  deviations_unraised  INTEGER NOT NULL DEFAULT 0,  -- scope deviations the agent found by examining the code that were NEVER flagged
  has_deviations       INTEGER NOT NULL DEFAULT 0,  -- 1 when anything is reduced / not-verified / an unraised deviation exists (drives escalation in a later slice)
  summary              TEXT,                         -- the agent's human-readable conformance summary
  report               TEXT,                         -- the full conformance report / transcript (nullable)
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
