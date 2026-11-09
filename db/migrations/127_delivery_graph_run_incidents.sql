-- Delivery-graph incident mirroring (issue #931). A delivery-graph RUN's engine instance can park
-- on a technical incident exactly as a convergence loop can — and was just as invisible: `/status`
-- kept reporting `running` while nothing moved. These four columns are the delivery-side twin of
-- the PR incident mirror (017 + 126), written by the SAME `pollIncidents` pass and surfaced on the
-- `/status` delivery rows. All NULL when the run's instance has no active incident.
ALTER TABLE delivery_graph_runs ADD COLUMN incident_key TEXT;      -- engine incidentKey of the active incident parking this run's instance; NULL when none
ALTER TABLE delivery_graph_runs ADD COLUMN incident_type TEXT;     -- the active incident's errorType; NULL when none
ALTER TABLE delivery_graph_runs ADD COLUMN incident_message TEXT;  -- the active incident's errorMessage; NULL when none
ALTER TABLE delivery_graph_runs ADD COLUMN incident_since TEXT;    -- the active incident's creationTime (ISO); NULL when none
