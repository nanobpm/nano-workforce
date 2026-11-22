-- Cancellation provenance rows carry a committed flag (PR #996 review, issue #994).
--
-- The cancel door records operator-cancel provenance BEFORE the engine cancel (so a crash in between
-- still leaves it) and used to delete the row whenever the engine cancel was not confirmed. Two
-- overlapping-request races broke that protocol:
--   - A retry over an already-out-of-band-terminated run inserted a row and the engine readback
--     confirmed TERMINATED, so the earlier termination was misattributed to the retrying caller.
--   - Request A inserted, request B re-used the row and committed its cancel, then A's cancel was
--     refused and A's rollback deleted B's committed provenance.
-- `committed` marks whether the engine confirmed the cancel this row names. The read models only fold
-- a COMMITTED row into the `cancelled` status; an uncommitted row is a provisional attempt its own
-- request may delete (a concurrent/failed request never touches a committed row). Rows written before
-- this column existed are already-recorded cancellations, so they default to committed (1); a NEW
-- provisional insert explicitly writes 0 and the door flips it to 1 once the engine confirms.
-- Additive only.

ALTER TABLE run_cancellations ADD COLUMN committed INTEGER NOT NULL DEFAULT 1;
