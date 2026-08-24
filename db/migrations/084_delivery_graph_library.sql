-- The reusable delivery-graph LIBRARY store (issue #522, epic #519 S3) — the durable base the
-- Library App-View (S4/#523), filesystem import (S5/#524), and export (S6/#525) build on. Unlike the
-- `staged` proposals store (`delivery_graph_proposals`, migration 075), which is content-digest-keyed
-- and TTL-swept, a library entry is meant to be EDITED and KEPT: its graph can change while its
-- identity stays stable, and it never ages out.
--
--   • id (PK) — a slug + short-hash of the entry's NAME (`<slug>-<sha256(name)[:8]>`), NOT the content
--     digest. Library entries are editable (the graph is mutable), so keying on the content would move
--     the row on every edit; keying on the (human, mutable) name gives a stable, human-readable id that
--     is idempotent on re-save of the same name (an upsert refreshes the graph, preserves created_at).
--   • name — the human name of the saved graph. Its slug/hash derives the id.
--   • description — an optional human note.
--   • graph — the `DeliveryGraph` JSON (serialised). Validated (compiled) at save time so an
--     uncompilable graph can never be persisted.
--   • source — how the entry entered the library: `composed` (saved from a raw graph JSON),
--     `imported` (loaded from the filesystem, S5/#524), `from-staged` (saved from a staged proposal's
--     digest), or `from-dispatched` (saved from a dispatched proposal's digest).
--   • created_at / updated_at — ISO-8601 timestamps; created_at is preserved across an idempotent
--     re-save of the same name. No `expires_at`: the library has NO TTL (contrast `delivery_graph_proposals`).
CREATE TABLE IF NOT EXISTS delivery_graph_library (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  graph TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'composed',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The list App-View orders entries newest-first; index the sort key.
CREATE INDEX IF NOT EXISTS ix_delivery_graph_library_created
  ON delivery_graph_library (created_at);
