-- ADR 0006 slice S2 (#589) — the `delivery_units` aggregate: ONE kind-tagged table consolidating the
-- four legacy delivery-unit representations (`feature_runs`, `plans`, `plan_tasks`,
-- `delivery_graph_runs`) that ADR 0006 §2 declared to be one aggregate. S1 (#494) delivered the derived
-- status union (app/deliveryUnitStatus.ts); this is its data-aggregate half.
--
-- EXPAND phase (ADR 0006 §S2 rollout, expand-and-contract): this migration + 089 (sync triggers) + 090
-- (backfill) ADD the aggregate and keep it in lockstep with the legacy tables, which stay the physical
-- WRITE target through S2 (the framework `instanceTracking` bindings + every app writer still target
-- them; ADR 0065 makes `instanceTracking` a SOURCE that no longer writes base rows, so the legacy base
-- `status` is only ever written through the app gateways — mirrored here at the DB level). 091 adds the
-- legacy-shaped compat VIEWs served FROM this aggregate, parity-tested against the base tables
-- (app/deliveryUnit.test.ts). Repointing live writers onto `delivery_units` and retiring the legacy
-- write paths is the later CONTRACT phase (S3), which the ADR sequences after the `instanceTracking`
-- doors move.
--
-- Identity (#464 "What survives"): `unit_id` is the universal, human-nameable cross-representation key
-- the dispatch door (S3) keys on — `feature:<key>` / `epic:<plan_key>` / `plan-task:<plan_key>#<idx>` /
-- `delivery-graph:<run_key>`. A run of an epic is ONE unit (`kind='epic'`); each of its slices is a
-- `kind='plan-task'` node under it (`parent_unit_id = 'epic:<plan_key>'`). `kind` is the closed §2 enum.
-- `dispatch_status` is the single dispatch door's status (S3 collapses onto it): 'pending' (created,
-- not yet dispatched), 'dispatched' (a live executor/instance), 'settled' (terminal or a live PR
-- resting stage — re-dispatchable), derived from the canonical `delivery_status`.
--
-- Every column except the identity pair (`unit_id`/`kind`) is nullable so a sync trigger over a
-- partial legacy row can never trip a NOT NULL. `delivery_status` is the canonical S1 union value;
-- `status` is the raw legacy source status (kept verbatim so the compat VIEWs reconstruct the legacy
-- rows losslessly). The runner wraps each file in its own transaction — no BEGIN/COMMIT here. Numbered
-- after the current highest prefix (087).

CREATE TABLE IF NOT EXISTS delivery_units (
  unit_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('feature', 'epic', 'plan-task', 'delivery-graph', 'bugfix', 'chore')),
  legacy_key TEXT,
  legacy_id INTEGER,
  parent_unit_id TEXT,
  node_index INTEGER,
  delivery_status TEXT,
  dispatch_status TEXT,
  repo TEXT,
  issue_number INTEGER,
  issue_url TEXT,
  title TEXT,
  base_branch TEXT,
  status TEXT,
  process_key TEXT,
  pr_key TEXT,
  outcome TEXT,
  acknowledged_at TEXT,
  list_bucket TEXT,
  created_at TEXT,
  updated_at TEXT,
  converge INTEGER,
  auto_merge INTEGER,
  delivery_label TEXT,
  stage TEXT,
  stage_state TEXT,
  stage_skipped TEXT,
  attention TEXT,
  task_count INTEGER,
  gate_wave INTEGER,
  blackboard_token TEXT,
  retro_started_at TEXT,
  epic_phase TEXT,
  promotion_pr TEXT,
  promotion_state TEXT,
  ack_open INTEGER,
  wait_gate TEXT,
  wait_gate_label TEXT,
  bound_artifacts TEXT,
  task_id TEXT,
  prompt TEXT,
  summary TEXT,
  wave INTEGER,
  open_question TEXT,
  answer TEXT,
  draft_pr_key TEXT,
  corr_key TEXT,
  process_definition_id TEXT,
  digest TEXT,
  side_effecting INTEGER,
  node_count INTEGER,
  human_node_count INTEGER,
  side_effect_count INTEGER,
  phase TEXT,
  phase_node_id TEXT,
  human_labels TEXT
);

CREATE INDEX IF NOT EXISTS ix_delivery_units_kind ON delivery_units (kind);
CREATE INDEX IF NOT EXISTS ix_delivery_units_dispatch_status ON delivery_units (dispatch_status);
CREATE INDEX IF NOT EXISTS ix_delivery_units_parent ON delivery_units (parent_unit_id);
CREATE INDEX IF NOT EXISTS ix_delivery_units_process_key ON delivery_units (process_key);
CREATE INDEX IF NOT EXISTS ix_delivery_units_pr_key ON delivery_units (pr_key);
CREATE INDEX IF NOT EXISTS ix_delivery_units_legacy_key ON delivery_units (legacy_key);
