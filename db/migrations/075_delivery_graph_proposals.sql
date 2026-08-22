-- The `staged` delivery-graph proposal store (ADR 0005 Decision 7, issue #460). This realises
-- `propose → preview → approve → dispatch` as intended: the agent-facing surface ends at
-- propose → compile → STAGE, and a HUMAN dispatches the staged proposal from the cockpit. The old
-- `approvalToken` was a REPLAYABLE content digest handed back to the same caller, so any holder of
-- the API credential self-approved. Removing the dispatch affordance from the agent surface (there is
-- no `start` endpoint) dissolves that hole: the compile door persists the compiled graph HERE as a
-- `staged` proposal and returns only a preview + a navigational `reviewUrl` — nothing that can trigger
-- a run. The cockpit lists these rows, renders the preview, and dispatches the one the operator picks.
--
--   • digest (PK) — the content address of the compiled graph (`sha256(compiled.bpmn)[:12]`), the
--     SAME digest the runner uses for the content-addressed deploy id. It NAMES the proposal so the
--     agent can hand the operator an unambiguous "dispatch <digest>" and the operator dispatches
--     EXACTLY the digest they previewed. A re-compile of the same bytes is idempotent (same PK).
--   • logical_key — the LOGICAL graph identity (the graph's `name`, else the digest) used to
--     SUPERSEDE: staging a changed graph (new digest) for the same logical key retires the prior
--     staged proposal, so the cockpit shows one live proposal per logical graph, not every recompile.
--   • graph — the original `DeliveryGraph` JSON, retained so the cockpit dispatch action can run the
--     runner for the previewed digest without the agent re-submitting anything.
--   • preview — the rendered preview JSON (`{ diagram, sideEffects, humanNodes }`) the cockpit shows,
--     stamped at stage time so the list renders without recompiling.
--   • status — `staged` (awaiting operator review), `superseded` (replaced by a newer digest for its
--     logical key), or `dispatched` (the operator launched it). Only non-expired `staged` rows show.
--   • expires_at — the TTL horizon. Staged proposals age out of the cockpit list so a stale entry an
--     operator never dispatched does not linger; the cockpit filters to `expires_at` in the future.
CREATE TABLE IF NOT EXISTS delivery_graph_proposals (
  digest TEXT PRIMARY KEY,
  logical_key TEXT NOT NULL,
  title TEXT,
  graph TEXT NOT NULL,
  preview TEXT NOT NULL,
  node_count INTEGER NOT NULL DEFAULT 0,
  human_node_count INTEGER NOT NULL DEFAULT 0,
  side_effect_count INTEGER NOT NULL DEFAULT 0,
  side_effecting INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'staged',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Supersede scans by logical_key; the cockpit list filters by status + expiry.
CREATE INDEX IF NOT EXISTS ix_delivery_graph_proposals_logical
  ON delivery_graph_proposals (logical_key);
CREATE INDEX IF NOT EXISTS ix_delivery_graph_proposals_status
  ON delivery_graph_proposals (status);
