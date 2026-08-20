-- The `startDeliveryGraph` run aggregate (ADR 0005 Decision 7, slice S5). The dispatch door
-- (`operations/startDeliveryGraph.ts`, POST /app/api/actions/start/delivery-graph) turns an
-- agent-authored `DeliveryGraph` into a RUNNING engine-native process (via the S4 runner) — but
-- because these graphs merge PRs and publish packages, dispatch is GATED on an approval of the
-- rendered preview and must be idempotent. This table is the aggregate that makes both properties
-- durable and gives the cockpit a row to show WHERE a run is parked:
--
--   • run_key (PK) — the idempotency key: a caller-supplied `idempotencyKey` or, by default, the
--     graph's content digest (`sha256(compiled.bpmn)[:12]`). A re-POST of the same graph collapses
--     onto the same row, so an in-flight (`running`) run short-circuits instead of double-launching
--     (mirrors `startPlan`'s `alreadyRunning`). The UNIQUE PK is the durable at-most-once fence.
--   • status — the run lifecycle: `awaiting-approval` (a side-effecting graph parked at the approval
--     gate — no instance started yet), `running` (dispatched to the engine), `done` (the instance
--     COMPLETED), `failed` (the instance TERMINATED, or instance-tracking reconciled a vanished
--     running instance — nano.app.json's `delivery_graph_runs` binding maps `onTerminated` to
--     `failed`), `abandoned` (a reserved terminal status in the lifecycle union, not currently
--     produced by the reconciler). `awaiting-approval`/`running` are the ACTIVE (in-flight) statuses shown in
--     the cockpit's active grid; only `running` is engine-instance-backed and thus instance-tracked
--     (nano.app.json keys off process_key), while `awaiting-approval` has no instance (process_key
--     NULL) and is display-only. The terminal three drop out of the cockpit's active grid.
--   • digest — the content-addressed approval token: a side-effecting graph dispatches only when the
--     caller presents `approvalToken == digest`. Persisted so a resumed/second POST can re-derive and
--     re-check it without recompiling out of band.
--   • phase / phase_node_id — the derived, display-only "where is it parked" projection the poller
--     (`pollDeliveryGraphPhase`) recomputes from the running instance's open user tasks (generalising
--     the epic_phase derived-phase machinery): e.g. "Parked on human node: manual OTP publish" vs a
--     bare "Running". NULL until the first projection / for a parked (not-yet-started) run.
--
-- process_key is the started instance key (NULL while `awaiting-approval`); the counts are the
-- compiled graph's shape (nodes / human stop-points / side effects), stamped at dispatch so the grid
-- and the approval gate need no recompile to render.
CREATE TABLE IF NOT EXISTS delivery_graph_runs (
  run_key TEXT PRIMARY KEY,
  process_key TEXT,
  process_definition_id TEXT,
  digest TEXT NOT NULL,
  status TEXT NOT NULL,
  side_effecting INTEGER NOT NULL DEFAULT 0,
  node_count INTEGER NOT NULL DEFAULT 0,
  human_node_count INTEGER NOT NULL DEFAULT 0,
  side_effect_count INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  phase TEXT,
  phase_node_id TEXT,
  -- JSON map of compiled human-task element id (`delivery-human-task__<element>`) → a display label
  -- (the human node's instruction first line, else its author node id). Stamped at dispatch so
  -- `pollDeliveryGraphPhase` can render "Parked on human node: <label>" from the run row + the open
  -- user tasks alone — no recompile of the graph in the poller.
  human_labels TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The instance-tracking reconciler and pollDeliveryGraphPhase both scan by process instance key.
CREATE INDEX IF NOT EXISTS ix_delivery_graph_runs_process_key
  ON delivery_graph_runs (process_key);
