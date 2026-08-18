-- 041_inter_epic_plan_deps.sql — issue #292 slice S1: first-class INTER-epic dependency edge.
--
-- `plan_task_deps` (005_plan_deps.sql) records the INTRA-epic task DAG — edges that order tasks
-- *within a single plan* into waves. There is no way today to say "epic B depends-on epic A": that
-- the whole of epic B must wait until epic A has published a capability before B may fan out.
--
-- This table adds that second, coarser grain: one row per INTER-epic edge. `plan_key` is the
-- dependent/consumer epic that waits; `depends_on_plan_key` is the producer epic it waits for. The
-- edge also carries the GATING CONTRACT DESCRIPTOR the later capability probe (slice S3) needs to
-- resolve which published `pkg@version` first carries the awaited capability: `package` is the
-- producer's published package name, and `capability_ref` is the producer epic's issue handle used
-- to resolve that version. This slice (S1) only lands the durable schema + typed read/write surface;
-- admission (S2), lowering into a readiness gate (S3), and visibility (S4) build on it later.
--
-- Constraints mirror how `plan_task_deps` is constrained:
--   • PRIMARY KEY (plan_key, depends_on_plan_key) — one edge per consumer→producer pair, so a
--     re-submitted set cannot duplicate an edge.
--   • CHECK (plan_key <> depends_on_plan_key) — an epic cannot depend on itself.
--   • plan_key REFERENCES plans(plan_key) — the consumer is an admitted plan (as plan_task_deps FKs
--     its plan_key). `depends_on_plan_key` is intentionally NOT FK-constrained: a batch admission
--     (S2) may insert edges before every producer row exists, and the set validator enforces that
--     every edge names a submitted epic. An index on plan_key backs the inbound read.
--
-- Numbered after the current highest prefix on origin/main (040); the runner wraps each file in its
-- own transaction, so this file must NOT contain BEGIN/COMMIT.

CREATE TABLE plan_deps (
  plan_key            TEXT NOT NULL REFERENCES plans(plan_key),  -- dependent/consumer epic that waits
  depends_on_plan_key TEXT NOT NULL,                             -- producer epic it waits for
  package             TEXT NOT NULL,                             -- producer's published package name
  capability_ref      TEXT NOT NULL,                             -- producer epic issue handle → pkg@version
  created_at          TEXT NOT NULL,
  PRIMARY KEY (plan_key, depends_on_plan_key),
  CHECK (plan_key <> depends_on_plan_key)
);

CREATE INDEX idx_plan_deps_plan ON plan_deps(plan_key);
CREATE INDEX idx_plan_deps_producer ON plan_deps(depends_on_plan_key);
