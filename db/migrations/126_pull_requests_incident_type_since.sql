-- Incident enrichment (issue #931). The #94 mirror carried only `incident_key` + `incident_message`
-- — enough to light a badge, not enough to answer "WHAT broke and SINCE WHEN" from the row, which is
-- what an operator triaging a parked loop needs (the merlin incidents were `JOB_NO_RETRIES` idle
-- timeouts; the errorType is the tell). `incident_type` is the engine incident's `errorType`;
-- `incident_since` its `creationTime` (ISO). Both NULL when the instance has no active incident —
-- the poller's `pollIncidents` pass clears all four columns together, idempotently.
ALTER TABLE pull_requests ADD COLUMN incident_type TEXT;   -- the active incident's errorType (e.g. JOB_NO_RETRIES); NULL when none
ALTER TABLE pull_requests ADD COLUMN incident_since TEXT;  -- the active incident's creationTime (ISO); NULL when none
