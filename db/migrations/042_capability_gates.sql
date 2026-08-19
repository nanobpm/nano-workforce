-- 042_capability_gates.sql — issue #289: the host-orchestrated CAPABILITY GATE tracker.
--
-- When plan-fanout dispatches a wave task that declared a cross-repo capability edge (`needs`, see
-- 041_plan_task_needs.sql), its per-task fan-out parks at the `wait-caps-resolved` message barrier
-- (plan-fanout.bpmn) instead of starting the agent. The host reconciler (`pollCapabilityGatesImpl`
-- in app/service.ts) then, for each such parked task, starts the EXISTING durable `readiness-gate`
-- process (readiness-gate.bpmn, #258) once per need — the bounded/idempotent/resumable wait that
-- escalates to an operator if the capability never ships — and reconciles, each pass, whether the
-- capability has shipped as a published `pkg@version`. When ALL of a task's needs have resolved it
-- publishes `caps-resolved` with the late-bound resolved-dependencies brief, releasing the barrier.
--
-- This table is that reconciler's durable, idempotent state: ONE row per (plan, task, need),
-- identified by the readiness-gate correlation key `<plan_key>:<task_id>:<capability_ref>`
-- (capabilityGateKey). It records the started gate's instance key (so we start it exactly once) and
-- the resolved `pkg@version` once the deterministic provenance lookup goes green, so a host restart
-- re-derives the whole picture from the DB (never re-starts a gate, never re-publishes a settled
-- barrier). `status` is 'pending' until the need resolves, then 'resolved'.
--
-- Numbered after the current highest prefix on origin/main (041); forward-only, additive (expand):
-- a brand-new table, so pre-#289 plans carry no gate rows and behave exactly as before. The runner
-- wraps each file in its own transaction, so no BEGIN/COMMIT here.

CREATE TABLE capability_gates (
  gate_key          TEXT PRIMARY KEY,   -- readiness-gate correlation key: <plan_key>:<task_id>:<capability_ref>
  plan_key          TEXT NOT NULL REFERENCES plans(plan_key),
  task_id           TEXT NOT NULL,      -- the consuming task's slug
  capability_ref    TEXT NOT NULL,      -- upstream handle: owner/repo#NNN | repo#NNN | #NNN (never a version)
  package           TEXT NOT NULL,      -- artifact whose releases carry provenance, e.g. @nanobpm/urban
  status            TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'resolved'
  resolved_artifact TEXT,               -- the late-bound pkg@version once resolved (NULL while pending)
  process_key       TEXT,               -- the started readiness-gate instance key (NULL until started)
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX idx_capability_gates_plan ON capability_gates(plan_key);
CREATE INDEX idx_capability_gates_task ON capability_gates(plan_key, task_id);
