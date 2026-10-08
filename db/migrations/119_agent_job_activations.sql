-- 119_agent_job_activations.sql — issue #879: distinguish a NEVER-ACTIVATED (queue-starved) agent
-- job from an ACTIVATED-but-hung one when an agent-task SLA boundary fires.
--
-- The agent-task SLA timer (`<bpmn:timeDuration>=agentSlaTimeout`) starts when the service task is
-- ENTERED, so it measures QUEUE time + RUN time. When no worker can take the job type (fleet
-- saturation / no capacity), the job sits CREATED (never leased) for the whole budget and the
-- boundary fires — yet the escalation reported it as "hung or looping", telling the human to "check
-- its progress" when there is none. (The reported case: a `senior:feature` job queued 2h, never
-- activated, then cancelled by its SLA boundary.)
--
-- The engine tracks JobState::Created vs ::Activated, but the Camunda-8 `/v2/jobs/search` wire API
-- collapses Activated -> CREATED (no ACTIVATED enum value); activation is read off the `worker` +
-- `deadline` fields — an activated job carries a leasing worker's name and a lock deadline, a
-- merely-queued one carries neither (same signal `pull_requests.active_worker`/`lease_until` use for
-- the review-round, migration 005). This ledger generalises that observation to EVERY bounded agent
-- job type (not just the review-round) and PERSISTS it, so when the SLA boundary cancels the job the
-- escalation recorder can still tell whether a worker ever picked it up.
--
-- The poller (`pollAgentActivations`, app/service.ts) upserts one row per (process_instance_key,
-- job_type) each pass: `first_seen_at` on first observation (job CREATED), and `activated_at` +
-- `worker` the first time it observes a leasing worker. The SLA-escalation recorders read it by the
-- same key (the agent job and its escalation recorder share one process instance) to word the
-- escalation accurately — "never started (queue starvation)" vs "started but exceeded its budget" —
-- including the job type and how long it waited.
--
-- Keyed by a surrogate TEXT id (`<process_instance_key>:<job_type>`) so the single-pk `data.table`
-- accessor can upsert it; the (process_instance_key, job_type) pair is unique per id. FK-free by
-- design — the owning instance lives in the durable ENGINE store, not app.db, so there is no app-tier
-- parent row to reference (mirrors `worker_durable_resume`/`worker_harness_protocol`). EXPAND
-- (additive) phase: one new table; nothing is dropped or renamed. The runner wraps each file in its
-- own transaction, so this file must NOT contain BEGIN/COMMIT.
CREATE TABLE IF NOT EXISTS agent_job_activations (
  id                   TEXT PRIMARY KEY,  -- surrogate: `<process_instance_key>:<job_type>`
  process_instance_key TEXT NOT NULL,     -- the engine instance the agent job (and its SLA recorder) runs in
  job_type             TEXT NOT NULL,     -- the agent job's `<zeebe:taskDefinition>` type (e.g. senior:feature)
  first_seen_at        TEXT NOT NULL,     -- ISO ts the poller first observed the job (CREATED/queued)
  activated_at         TEXT,              -- ISO ts first observed ACTIVATED (leasing worker seen); NULL = never started
  worker               TEXT,              -- the leasing worker's name at activation; NULL until activated
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_agent_job_activations_instance ON agent_job_activations (process_instance_key);
