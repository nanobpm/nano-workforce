-- Loop-termination provenance (issue #943). A merge loop was terminated in-app (the waiting-merge →
-- convergence hand-off) with no successor and no escalation, and nothing on the row said why — the PR
-- silently dropped off `/status`. Every APP-INITIATED cancel of a PR's convergence/merge loop now
-- stamps a one-line reason here (via `terminatePrLoop` in app/service.ts), naming the outcome it
-- led to (a successor convergence instance, or the PR's terminal GitHub state). NULL when the current
-- run was never cancelled by the app. `/status` surfaces it, and an `orphaned` overlay flags a PR
-- whose loop ended with NO recorded reason, no successor and no escalation.
ALTER TABLE pull_requests ADD COLUMN termination_reason TEXT;

-- The instance the reason describes (PR #944 review): provenance is bound to the CANCELLED instance and
-- only explains a termination while it equals the row's `process_key`, so a predecessor's reason can
-- never mask the later orphaning of a successor.
ALTER TABLE pull_requests ADD COLUMN termination_process_key TEXT;
