// Read-model coverage for the delivery-graph progress projection — the member-PR rollup, the coarse-key
// stage/stage_state derivation, and the promoted `pipeline` render binding — authored via Urban's
// ADR-0065 declare-once primitives (app/deliveryGraphReadModel.ts). ADR 0006 §4b, issue #541 / S7; the
// exemplars are app/featureReadModel.test.ts and app/planReadModel.test.ts.
//
// Guards:
//   1. DRIFT GUARD — migration 086 embeds the rollup VIEW DDL VERBATIM from `rollup.viewDdl()` and each
//      derived column VERBATIM from `deliveryGraphReadModel.sqlSelectFor(...)`, so the checked-in VIEWs
//      cannot drift from the declarations.
//   2. FRAMEWORK PARITY GUARD — `assertRollupParity` / `assertReadModelParity` prove the SQL and TS
//      lowerings each declaration compiles to agree.
//   3. END-TO-END BEHAVIOUR on the REAL migration VIEW (086 applied to an in-memory DB): the coarse-key
//      matrix, the member-PR temper, the terminal-fold bypass, and the companion `park_label`.
//   4. PARITY vs TODAY'S PHASE — for representative `deriveDeliveryPhase` outputs (what the plain Phase
//      text cell showed), the derived stepper matches, and the actionable park label is retained.
//   5. ONE PROJECTION — the VIEW's (stage, state) equals `reduceFrontier` of the single derived branch,
//      tying the render half to the canonical axis (app/stepAxis.ts).
//   6. PAGE BINDINGS — the delivery-graph pages bind the derived VIEW + the `pipeline` kind, not a plain
//      `phase` text cell on the raw table.

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertReadModelParity, assertRollupParity, type ParityDb, type ParitySample, type ProcessInstanceState, type RollupInputs } from "@nanobpm/urban";
import { assert, assertEquals } from "#test-assert";
import { deriveDeliveryPhase } from "./deliveryGraphRun.ts";
import {
  DELIVERY_GRAPH_READ_MODEL_BASE_ALIAS,
  DELIVERY_GRAPH_READ_MODEL_DERIVED,
  DELIVERY_GRAPH_ROLLUPS,
  deliveryGraphPrCounts,
  deliveryGraphReadModel,
  PR_COUNTS_LOOKUP,
} from "./deliveryGraphReadModel.ts";
import { reduceFrontier, type StepKey } from "./stepAxis.ts";
import { applyMigrationSet, readMigrationSetFromDisk } from "../test/migrations.ts";

const MIG = (name: string) => readFileSync(fileURLToPath(new URL(`../db/migrations/${name}`, import.meta.url)), "utf8");
const PAGE = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../pages/${name}`, import.meta.url)), "utf8"));

const READ_MODEL_MIGRATION = "086_delivery_graph_read_model.sql";

// A minimal in-memory DB carrying the base `delivery_graph_runs` / `pull_requests` shapes the VIEW
// reads, plus stand-ins for the managed `<table>__tracking` derived VIEWs urban provisions at mount
// (each re-exports `base.*` plus the terminal-folded `derived_status`). `derived_status_override` models
// the reconciler's derive edge (a terminated instance ⇒ `failed`/`abandoned` while base `status` stays
// frozen). Then migration 086 (the rollup VIEW + the read model VIEW) is applied.
function viewDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE delivery_graph_runs (
       run_key TEXT PRIMARY KEY, process_key TEXT, process_definition_id TEXT, digest TEXT,
       status TEXT, side_effecting INTEGER, node_count INTEGER, human_node_count INTEGER,
       side_effect_count INTEGER, title TEXT, phase TEXT, phase_node_id TEXT, human_labels TEXT,
       created_at TEXT, updated_at TEXT, derived_status_override TEXT);
     CREATE TABLE pull_requests (pr_key TEXT PRIMARY KEY, root_request_key TEXT, status TEXT,
       derived_status_override TEXT);`,
  );
  db.exec(
    `CREATE VIEW delivery_graph_runs__tracking AS
       SELECT d.*, COALESCE(d.derived_status_override, d.status) AS derived_status FROM delivery_graph_runs d;
     CREATE VIEW pull_requests__tracking AS
       SELECT p.*, COALESCE(p.derived_status_override, p.status) AS derived_status FROM pull_requests p;`,
  );
  db.exec(MIG(READ_MODEL_MIGRATION));
  return db;
}

interface SampleRun {
  status: string;
  phase?: string | null;
  phase_node_id?: string | null;
  derived_status_override?: string | null;
}

function addRun(db: DatabaseSync, run_key: string, run: SampleRun): void {
  db.prepare(
    `INSERT INTO delivery_graph_runs
       (run_key, process_key, process_definition_id, digest, status, side_effecting, node_count,
        human_node_count, side_effect_count, title, phase, phase_node_id, human_labels, created_at,
        updated_at, derived_status_override)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run_key,
    `pk-${run_key}`,
    "delivery-graph",
    `digest-${run_key}`,
    run.status,
    0,
    3,
    1,
    0,
    `Graph ${run_key}`,
    run.phase ?? null,
    run.phase_node_id ?? null,
    null,
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
    run.derived_status_override ?? null,
  );
}

function addPr(db: DatabaseSync, pr_key: string, root_request_key: string | null, status: string, derived_status_override: string | null = null): void {
  db.prepare("INSERT INTO pull_requests (pr_key, root_request_key, status, derived_status_override) VALUES (?, ?, ?, ?)").run(
    pr_key,
    root_request_key,
    status,
    derived_status_override,
  );
}

function projection(db: DatabaseSync, run_key: string): { stage: string; stage_state: string | null; park_label: string | null; status: string } {
  const r = db
    .prepare("SELECT stage, stage_state, park_label, status FROM delivery_graph_read_model WHERE run_key = ?")
    .get(run_key) as { stage: string; stage_state: string | null; park_label: string | null; status: string };
  return { stage: r.stage, stage_state: r.stage_state, park_label: r.park_label, status: r.status };
}

// A `ParityDb` over node:sqlite's `DatabaseSync` for the framework parity guards.
function parityDb(db: DatabaseSync): ParityDb {
  return {
    exec: (sql) => db.exec(sql),
    all: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])) as T[],
    run: (sql, params: unknown[] = []) => {
      const r = db.prepare(sql).run(...(params as never[]));
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    },
  };
}

// ── 1. DRIFT GUARD ────────────────────────────────────────────────────────────────────────────────

test("DRIFT GUARD: migration 086 embeds the rollup VIEW DDL VERBATIM from rollup.viewDdl() (the VIEW cannot drift from defineRollup)", () => {
  const sql = MIG(READ_MODEL_MIGRATION);
  for (const rollup of DELIVERY_GRAPH_ROLLUPS) {
    assert(
      sql.includes(rollup.viewDdl()),
      `migration ${READ_MODEL_MIGRATION} no longer embeds the declaration's VIEW DDL for rollup "${rollup.decl.name}" — ` +
        `regenerate it from app/deliveryGraphReadModel.ts. Expected to contain:\n${rollup.viewDdl()}`,
    );
    assert(new RegExp(`DROP VIEW IF EXISTS ${rollup.decl.name};`).test(sql), `086 must DROP "${rollup.decl.name}" first`);
  }
});

test("DRIFT GUARD: migration 086 embeds each derived column VERBATIM from deliveryGraphReadModel.sqlSelectFor (the VIEW cannot drift from the declaration)", () => {
  const sql = MIG(READ_MODEL_MIGRATION);
  const alias = DELIVERY_GRAPH_READ_MODEL_BASE_ALIAS;
  for (const c of DELIVERY_GRAPH_READ_MODEL_DERIVED) {
    const emitted = deliveryGraphReadModel.sqlSelectFor(c, { baseAlias: alias });
    assert(
      sql.includes(`${emitted} AS ${c}`),
      `migration ${READ_MODEL_MIGRATION} no longer embeds the declaration's SQL for "${c}" — regenerate it from ` +
        `app/deliveryGraphReadModel.ts. Expected to contain:\n  ${emitted} AS ${c}`,
    );
  }
  assert(/DROP VIEW IF EXISTS delivery_graph_read_model;/.test(sql), "086 must DROP the VIEW first");
  assert(/CREATE VIEW delivery_graph_read_model AS/.test(sql), "086 must (re)create delivery_graph_read_model");
  // Base identity pass-throughs — DERIVED from the REAL `delivery_graph_runs` schema (the migration
  // chain applied to a throwaway DB), NOT a hand-kept list that could silently omit a column: the VIEW
  // must re-export EVERY base column so the static pages↔schema contract guard sees them (and a future
  // regeneration can't drop one without failing here). `status` is the one exception — it is exposed as
  // the effective COALESCE below rather than a bare pass-through — so it is asserted separately.
  const schemaDb = new DatabaseSync(":memory:");
  applyMigrationSet(schemaDb, readMigrationSetFromDisk());
  const baseColumns = (schemaDb.prepare("PRAGMA table_info(delivery_graph_runs)").all() as { name: string }[]).map((r) => r.name);
  schemaDb.close();
  assert(baseColumns.length > 0, "the migration chain must create the delivery_graph_runs base table");
  for (const base of baseColumns) {
    if (base === "status") continue;
    assert(sql.includes(`dg.${base} AS ${base}`), `086 must pass base column "${base}" through the VIEW (derived from the real delivery_graph_runs schema)`);
  }
  assert(sql.includes("COALESCE(dg.derived_status, dg.status) AS status"), "086 must expose the effective status so the pages' Active/History filter tracks a terminated run");
  assert(sql.includes("AS park_label"), "086 must carry the hand-authored park_label companion column");
  // FROM/JOIN relations are DERIVED from the declaration (baseTable + lookup rollup name + join keys).
  const alias2 = DELIVERY_GRAPH_READ_MODEL_BASE_ALIAS;
  assert(sql.includes(`FROM ${deliveryGraphReadModel.decl.baseTable} ${alias2}`), `086's FROM must be the declaration's baseTable "${deliveryGraphReadModel.decl.baseTable}"`);
  for (const lk of deliveryGraphReadModel.decl.lookups) {
    const on = lk.on.map((k) => `${alias2}.${k.base} = ${lk.as}.${k.rollup}`).join(" AND ");
    const join = `LEFT JOIN ${lk.rollup.decl.name} ${lk.as} ON ${on}`;
    assert(sql.includes(join), `086 must LEFT JOIN the declaration's "${lk.rollup.decl.name}" lookup exactly as "${join}"`);
  }
});

// ── 2. FRAMEWORK PARITY GUARD ──────────────────────────────────────────────────────────────────────

test("FRAMEWORK PARITY GUARD: delivery_graph_pr_counts VIEW and TS reduce agree (assertRollupParity)", () => {
  const sampleSets: RollupInputs[] = [
    {
      pull_requests__tracking: [
        { pr_key: "p0", root_request_key: "run-a", derived_status: "converging" },
        { pr_key: "p1", root_request_key: "run-a", derived_status: "merged" },
        { pr_key: "p2", root_request_key: "run-a", derived_status: "waiting_review" },
        { pr_key: "p3", root_request_key: "run-b", derived_status: "abandoned" },
        { pr_key: "p4", root_request_key: "run-b", derived_status: "converged" },
        { pr_key: "p5", root_request_key: null, derived_status: "converging" },
      ],
    },
    { pull_requests__tracking: [] },
  ];
  for (const rollup of DELIVERY_GRAPH_ROLLUPS) {
    const db = new DatabaseSync(":memory:");
    assertRollupParity(rollup, parityDb(db), sampleSets);
    db.close();
  }
});

test("FRAMEWORK PARITY GUARD: deliveryGraphReadModel's SQL and TS lowerings agree over the status × PR-in-flight matrix (assertReadModelParity)", () => {
  const samples: ParitySample[] = [];
  for (const status of ["awaiting-approval", "running", "done", "failed", "abandoned"]) {
    for (const derived_status of [status, "failed"]) {
      for (const prs_in_flight of [0, 1, 3]) {
        samples.push({
          baseRow: { run_key: "self", status, derived_status },
          lookups: { [PR_COUNTS_LOOKUP]: [{ root_request_key: "self", prs_in_flight }] },
        });
      }
    }
  }
  const db = new DatabaseSync(":memory:");
  assertReadModelParity(deliveryGraphReadModel, parityDb(db), samples, { sql: { baseAlias: DELIVERY_GRAPH_READ_MODEL_BASE_ALIAS } });
  db.close();
});

// ── 3. END-TO-END BEHAVIOUR on the real migration VIEW ────────────────────────────────────────────

test("the migration 086 VIEW maps the run lifecycle onto the coarse STAGE_KEYS bracket + render state", () => {
  const db = viewDb();
  // awaiting-approval (reserved legacy pre-dispatch rows) → the initial Requested bracket.
  addRun(db, "await", { status: "awaiting-approval", phase: "Awaiting approval" });
  // running, dispatch begun, no PR frontier → the deterministic initial Implementing.
  addRun(db, "run-plain", { status: "running", phase: "Running" });
  // terminal done → Done / ok (settles outright).
  addRun(db, "done", { status: "done", phase: "Completed" });
  // terminal failed / abandoned → the Done tail bracket / failed.
  addRun(db, "failed", { status: "failed", phase: "Failed" });
  addRun(db, "aband", { status: "abandoned", phase: "Failed" });

  assertEquals(projection(db, "await"), { stage: "Requested", stage_state: null, park_label: null, status: "awaiting-approval" });
  assertEquals(projection(db, "run-plain"), { stage: "Implementing", stage_state: null, park_label: null, status: "running" });
  assertEquals(projection(db, "done"), { stage: "Done", stage_state: "ok", park_label: null, status: "done" });
  assertEquals(projection(db, "failed"), { stage: "Done", stage_state: "failed", park_label: null, status: "failed" });
  assertEquals(projection(db, "aband"), { stage: "Done", stage_state: "failed", park_label: null, status: "abandoned" });
  db.close();
});

test("a running run with a member PR still in flight (root_request_key = run_key) tempers to Converging; all-terminal members stay Implementing", () => {
  const db = viewDb();
  addRun(db, "run-c", { status: "running", phase: "Running" });
  addPr(db, "pr-open", "run-c", "converging");
  addPr(db, "pr-merged", "run-c", "merged");

  addRun(db, "run-i", { status: "running", phase: "Running" });
  addPr(db, "pr-done", "run-i", "merged");
  addPr(db, "pr-gone", "run-i", "abandoned");

  assertEquals(projection(db, "run-c").stage, "Converging");
  assertEquals(projection(db, "run-i").stage, "Implementing");
  db.close();
});

test("an out-of-band-terminated member PR (derived_status='abandoned', base frozen) is NOT held in the live frontier", () => {
  const db = viewDb();
  addRun(db, "run-x", { status: "running", phase: "Running" });
  // Base status frozen at 'converging' but the reconciler's derive edge reports 'abandoned' (resolved).
  addPr(db, "pr-stale", "run-x", "converging", "abandoned");
  assertEquals(projection(db, "run-x").stage, "Implementing");
  db.close();
});

test("a DERIVE-ONLY terminated run (base status frozen at 'running', derived_status='failed') renders Done/failed, not wedged Implementing", () => {
  const db = viewDb();
  addRun(db, "run-t", { status: "running", phase: "Running", derived_status_override: "failed" });
  const p = projection(db, "run-t");
  assertEquals(p.stage, "Done");
  assertEquals(p.stage_state, "failed");
  // The effective status the pages filter on tracks the derive edge (so it drops to History).
  assertEquals(p.status, "failed");
  db.close();
});

test("park_label carries the actionable 'Parked on human node: <label>' text (only when parked); the pipeline stage is unaffected", () => {
  const db = viewDb();
  addRun(db, "run-park", { status: "running", phase: "Parked on human node: manual OTP publish", phase_node_id: "delivery-human-task__n3" });
  const p = projection(db, "run-park");
  assertEquals(p.park_label, "Parked on human node: manual OTP publish");
  // A pre-PR parked frontier still pins the scalar activeField to the current bracket (Implementing).
  assertEquals(p.stage, "Implementing");
  // A non-park phase leaves park_label null.
  addRun(db, "run-np", { status: "running", phase: "Running" });
  assertEquals(projection(db, "run-np").park_label, null);
  db.close();
});

// ── 4. PARITY vs TODAY'S PHASE (the acceptance parity) ────────────────────────────────────────────

test("the derived stepper matches TODAY's plain `phase` text (deriveDeliveryPhase) for representative runs, retaining the actionable park label", () => {
  const db = viewDb();
  const humanLabels = { "delivery-human-task__n3": "manual OTP publish" };
  // Each fixture is what `pollDeliveryGraphPhase` records today; assert the derived stepper equals the
  // step that plain phase text conveyed, and the park label is preserved when parked.
  const cases: Array<{
    key: string;
    state: ProcessInstanceState | null;
    tasks: Array<{ elementId?: string }>;
    expectStage: StepKey;
    expectState: string | null;
    parked: boolean;
  }> = [
    { key: "running", state: "ACTIVE", tasks: [], expectStage: "Implementing", expectState: null, parked: false },
    { key: "parked", state: "ACTIVE", tasks: [{ elementId: "delivery-human-task__n3" }], expectStage: "Implementing", expectState: null, parked: true },
    { key: "completed", state: "COMPLETED", tasks: [], expectStage: "Done", expectState: "ok", parked: false },
    { key: "terminated", state: "TERMINATED", tasks: [], expectStage: "Done", expectState: "failed", parked: false },
  ];
  for (const c of cases) {
    const proj = deriveDeliveryPhase(c.state, c.tasks, humanLabels);
    addRun(db, c.key, { status: proj.status, phase: proj.phase, phase_node_id: proj.phase_node_id });
    const p = projection(db, c.key);
    assertEquals(p.stage, c.expectStage, `stage for today's phase "${proj.phase}"`);
    assertEquals(p.stage_state, c.expectState, `state for today's phase "${proj.phase}"`);
    assertEquals(p.park_label, c.parked ? proj.phase : null, `park_label for today's phase "${proj.phase}"`);
  }
  db.close();
});

// ── 5. ONE PROJECTION — the render half agrees with the canonical axis reducer ────────────────────

test("the VIEW's (stage, state) equals reduceFrontier of the single derived branch (feature + delivery-graph collapse onto one axis)", () => {
  const db = viewDb();
  const settle = (status: string): string | null => (status === "done" ? "done" : status === "failed" || status === "abandoned" ? status : null);
  addRun(db, "b-run", { status: "running", phase: "Running" });
  addRun(db, "b-done", { status: "done", phase: "Completed" });
  addRun(db, "b-failed", { status: "failed", phase: "Failed" });
  for (const key of ["b-run", "b-done", "b-failed"]) {
    const p = projection(db, key);
    const status = key.slice(2);
    const reduced = reduceFrontier([{ nodeId: key, step: p.stage as StepKey, terminal: settle(status) }]);
    assertEquals(p.stage, reduced.step, `single-branch reduce step for ${key}`);
    assertEquals(p.stage_state, reduced.state, `single-branch reduce state for ${key}`);
  }
  db.close();
});

// ── 6. PAGE BINDINGS ──────────────────────────────────────────────────────────────────────────────

function pipelineColumnsOf(page: unknown): Array<Record<string, unknown>> {
  const cols: Array<Record<string, unknown>> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (o.kind === "pipeline") cols.push(o);
      for (const v of Object.values(o)) walk(v);
    }
  };
  walk(page);
  return cols;
}

function datasourceTables(page: unknown): string[] {
  const tables: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (o.kind === "datasource" && typeof o.table === "string") tables.push(o.table);
      for (const v of Object.values(o)) walk(v);
    }
  };
  walk(page);
  return tables;
}

for (const pageName of ["delivery-graphs.page.json", "delivery-graph-detail.page.json", "overview.page.json"]) {
  test(`${pageName} binds the derived delivery_graph_read_model VIEW and a pipeline stepper (not a plain phase cell on the raw table)`, () => {
    const page = PAGE(pageName);
    const tables = datasourceTables(page);
    assert(tables.includes("delivery_graph_read_model"), `${pageName} must bind delivery_graph_read_model`);
    assert(!tables.includes("delivery_graph_runs"), `${pageName} must NOT bind the raw delivery_graph_runs table for the run grid`);

    const pipelines = pipelineColumnsOf(page);
    assert(pipelines.length >= 1, `${pageName} must render a pipeline stepper for the delivery graph`);
    const p = pipelines.find((c) => c.activeField === "stage");
    assert(p !== undefined, `${pageName} pipeline must bind activeField "stage"`);
    assertEquals(p.stateField, "stage_state");
    // v1 does NOT populate the aggregate's notInPathField (§4b §287-291).
    assert(p.notInPathField === undefined, `${pageName} S7 pipeline must not bind notInPathField (deferred with the set-valued render)`);
    // The six canonical STAGE_KEYS brackets, seeded from the axis.
    const stages = p.stages as Array<{ key: string }>;
    assertEquals(stages.map((s) => s.key), ["Requested", "Implementing", "PR open", "Converging", "Merging", "Done"]);
  });
}
