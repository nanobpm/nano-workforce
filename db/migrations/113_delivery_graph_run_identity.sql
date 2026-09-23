-- Delivery Graphs: persist a LOSSLESS graph-identity fingerprint per run in a dedicated SIDE TABLE
-- (issue #778 review — thread dispatchDeliveryGraph.ts:332).
--
-- A run is keyed by `run_key` (an explicit operator `idempotencyKey`, else the content `digest`). The
-- `digest` is content-addressed over the REDACTED `semanticBpmn`, so two graphs differing ONLY in a
-- redacted-away secret (a URL credential, a `command` target, a match secret, a free-form connector
-- `payload`, …) SHARE one digest. When an operator supplies an explicit `idempotencyKey`, a re-dispatch
-- short-circuits onto the existing running row — but the lossy `digest` on that row cannot prove the
-- short-circuited run is THIS exact secret-bearing graph vs. a credential-different graph re-staged under
-- the same key. The dispatch door therefore refused EVERY such short-circuit with 409, which also broke
-- the idempotency contract for a legitimate SAME-payload retry (a lost response / double-click of the
-- identical proposal): it received 409 and lingered `staged` instead of short-circuiting successfully.
--
-- `graph_fingerprint` stores the run's lossless content identity — `sha256(digest \0
-- canonicalJson(digestInvisibleRawValues(graph)))` (the SAME identity `stableProposalRunKey` folds into
-- the keyless run key) — captured at launch. On an explicit-key short-circuit the door compares the
-- incoming graph's fingerprint against the stored one: a MATCH is a same-payload retry (allow the
-- short-circuit + consume the proposal); a MISMATCH — or a MISSING row (a run that predates this table)
-- — is unprovable, so the door refuses (the safe pre-existing 409 behaviour) and it self-heals once the
-- run turns over.
--
-- WHY A SIDE TABLE, not a column on `delivery_graph_runs`: that base table is projected COLUMN-FOR-COLUMN
-- by several drift-guarded surfaces — the `delivery_graph_runs__units` compat VIEW served from the
-- `delivery_units` aggregate (091/098) and the `delivery_graph_read_model`/`__tracking` VIEWs (087/096),
-- each of which asserts full base-column pass-through parity. This identity fingerprint is an INTERNAL
-- dispatch concern surfaced to no read model, so it belongs off to the side rather than threaded through
-- (and re-drift-guarded across) every projection.
--
-- Forward-only, additive (expand). The runner wraps each file in its own transaction — no BEGIN/COMMIT.
-- Numbered after 112 (the current highest on origin/main; this branch forked before 103–112 and must not
-- reuse a prefix main already occupies).

CREATE TABLE IF NOT EXISTS delivery_graph_run_identity (
  run_key TEXT PRIMARY KEY,
  graph_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL
);
