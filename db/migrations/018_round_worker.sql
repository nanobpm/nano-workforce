-- Identify the servicing worker on the durable history. The c8ctl harness completes each agent
-- job with an `agent` variable (its profile name, e.g. `senior`), which propagates to the
-- downstream `pr.persist-round` / `pr.persist-escalation` jobs. Recording it next to the round /
-- escalation the agent produced lets a human tell *which* worker did the work when reading the
-- transcript — without cross-referencing the transient `pull_requests.active_worker` lease (which
-- is cleared once the agent finishes).

ALTER TABLE rounds ADD COLUMN worker TEXT;
ALTER TABLE escalations ADD COLUMN worker TEXT;
