-- 052_worker_durable_resume.sql — issue #325 (ADR 0062, Slice 5/5): the ENROLMENT GATE for durable
-- agent-session resume. Slices 1–4 built the mind (harness conversation) and world (git tree + effect
-- ledger) halves; this slice wires them into the running orchestration behind a `durable-resume`
-- enrolment gate so a re-leased `senior:pr-review` round RESUMES at the last push-checkpoint on a
-- participating harness, and gracefully DEGRADES (redriven from scratch, exactly as today) on one
-- that does not advertise it.
--
-- `durable-resume` is a WORKER ATTRIBUTE declared at enrolment (ADR 0056 §7 — capability gates
-- enrolment, it is NEVER in the routing token `network.role#seat`). The registry records, per worker
-- instance, whether that worker's harness advertises durable-resume (the probe result from Slice
-- 2/3). The world-restore `commitSha` is emitted into the repo-provisioning envelope ONLY when the
-- fleet includes a participant; a fleet with no participant emits no resume marker and clones the
-- head branch tip — the pre-#324 behaviour. Resume is purely additive, never a new sequence-flow
-- gate (ADR 0056 boundary): the engine/C8 job protocol is untouched.
--
-- One FK-free table keyed by the worker instance (`register.instance` / the enrol `instance`). It is
-- FK-free by design — enrolment is per-worker and connection-agnostic, with no `pull_requests`/`plans`
-- parent to reference. EXPAND (additive) phase: one new table + its index; nothing is dropped or
-- renamed. Numbered after the current highest prefix on origin/main (051). The runner wraps each file
-- in its own transaction, so this file must NOT contain BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS worker_durable_resume (
  instance       TEXT PRIMARY KEY,            -- the worker instance id (enrol `instance` / register.instance)
  durable_resume INTEGER NOT NULL DEFAULT 0,  -- 1 when the worker's harness advertises durable-resume, else 0
  updated_at     TEXT NOT NULL,
  -- `durable_resume` is a strict boolean domain — the gate reads it as "does this worker participate?",
  -- so a stray value (a future writer bug, a corrupt row on this externalised enrolment boundary) would
  -- make the gate mis-decide whether to emit the resume marker. Pin it to {0,1} at the schema.
  CHECK (durable_resume IN (0, 1))
);

-- The gate asks "does the fleet include a durable-resume participant?" — an existence probe over the
-- participants. Index the flag so that lookup is a covered scan, not a table walk.
CREATE INDEX IF NOT EXISTS idx_worker_durable_resume_flag
  ON worker_durable_resume(durable_resume);
