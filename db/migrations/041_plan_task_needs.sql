-- 041_plan_task_needs.sql — issue #289: the cross-repo CAPABILITY EDGE on a plan task.
--
-- A plan task may declare a cross-repo capability dependency (the "consumer readiness edge",
-- ADR 0001 §4, #263): it consumes an upstream capability C that is published as some
-- `pkg@version` from ANOTHER repo, and must not start until that capability first ships. The
-- planner emits this as an optional `needs: CapabilityNeed[]` on each `RecordPlanTask`
-- (plan-fanout.bpmn); this table is where `pr.record-plan` levelizes it to, mirroring
-- `plan_task_deps` (the intra-epic edge table). One row per (task, capability need).
--
-- `capability_ref` is the STABLE upstream handle (`owner/repo#NNN`, `repo#NNN`, or `#NNN`) —
-- NEVER a version (the #263 core decision: declare the handle, resolve the version at the gate).
-- `package` is the artifact whose GitHub Releases carry the publish provenance (`@nanobpm/urban`),
-- per-package scoped so a sibling package's provenance can't leak in. `verify_command` is the
-- OPTIONAL gated empirical fallback (#274 decision 5) — deterministic provenance stays the default.
--
-- Keyed on `plan_key` (like plan_task_deps) so a single delete clears a plan's whole need set on a
-- re-plan / idempotent re-run. Forward-only, additive (expand): a brand-new table, so pre-#289 rows
-- and plans carry no needs and behave exactly as before. Numbered after the current highest prefix
-- on origin/main (040); the runner wraps each file in its own transaction, so no BEGIN/COMMIT here.

CREATE TABLE plan_task_needs (
  plan_key        TEXT NOT NULL REFERENCES plans(plan_key),
  task_id         TEXT NOT NULL,   -- the consuming task's slug
  capability_ref  TEXT NOT NULL,   -- upstream handle: owner/repo#NNN | repo#NNN | #NNN (never a version)
  package         TEXT NOT NULL,   -- artifact whose releases carry provenance, e.g. @nanobpm/urban
  verify_command  TEXT,            -- optional gated empirical fallback (NULL = deterministic-only)
  PRIMARY KEY (plan_key, task_id, capability_ref, package)
);

CREATE INDEX idx_plan_task_needs_plan ON plan_task_needs(plan_key);
