-- Technical-incident surfacing (issue #94). A convergence or merge process instance can hit a
-- *technical* incident — an unhandled engine error (an expression failure, a job that exhausted
-- its retries, …) that parks the token — and until now nothing on the PR row reflected it: the
-- grid kept showing the last workflow status (`converging`, `merging`, …) while the run was
-- actually stuck. A PR sat "converging" all day while its instance was dead on an incident.
--
-- These two orthogonal columns mirror an ACTIVE engine incident onto the PR row, written by the
-- poller's `pollIncidents` pass from a `/v2/incidents/search` filtered by the PR's `process_key`.
-- They are deliberately independent of `status`: an incident is a *cross-cutting* liveness fault,
-- not a workflow stage, so surfacing it must not overload the status machine. NULL means the
-- instance has no active incident (never had one, or it was resolved) — the poller clears the
-- columns idempotently, so an incident raised or resolved out-of-band converges on the next pass.
ALTER TABLE pull_requests ADD COLUMN incident_key TEXT;      -- engine incidentKey of the active incident parking this PR's instance; NULL when none
ALTER TABLE pull_requests ADD COLUMN incident_message TEXT;  -- the incident's errorMessage, surfaced on the grid; NULL when none
