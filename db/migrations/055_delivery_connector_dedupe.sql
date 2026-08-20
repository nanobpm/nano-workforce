-- The delivery-graph `connector` node's idempotency ledger (ADR 0005 Decision 6/7, slice S4). A
-- `connector` is the epic's one SIDE-EFFECTING node kind (`agent`/`wait`/`human` are read-only or
-- human-gated): it drives an outbound action against the forward-declared connector I/O surface. The
-- engine delivers a service-task job AT-LEAST-ONCE — a worker/hub restart, a lost completion ack, or a
-- graph resume re-activates the same job — so a naive connector would double-fire its side effect on
-- every redelivery. This ledger makes each dispatch fire AT-MOST-ONCE per dedupe key: the worker
-- claims the key here BEFORE performing the action, and a redelivery that finds the key already
-- claimed short-circuits to the recorded outcome instead of re-dispatching.
--
-- The UNIQUE fence on `dedupe_key` is the durable at-most-once guarantee (the canonical durable-fence
-- idiom — cf. `ux_merges_abandon_pr_closed` in 053 and the world-store ledgers in 049): a concurrent
-- redelivery that races the claim loses the insert and is classified by `app/dbFence.ts`
-- (`isUniqueConstraintFence`) as the SAME idempotent outcome, never a spurious job failure. The key is
-- author-supplied (`connector.dedupeKey`) or graph-derived (`<processInstanceKey>:<elementId>`) — both
-- stable across a re-activation of the same node instance.
CREATE TABLE IF NOT EXISTS delivery_connector_dispatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL,
  target TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail TEXT,
  dispatched_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_delivery_connector_dedupe
  ON delivery_connector_dispatches (dedupe_key);
