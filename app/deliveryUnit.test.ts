// Coverage for ADR 0006 slice S2 (#589) — the `delivery_units` aggregate and its DB-level sync.
//
// Proves, against a REAL in-memory SQLite with the full migration set applied:
//   1. VOCABULARY PARITY — the TS `DELIVERY_UNIT_KINDS` closed enum matches the `CHECK (kind IN (…))`
//      constraint in migration 088 (the two lowerings of the §2 kind enum can't drift).
//   2. DERIVATION PARITY — for every source status of every shape, the DB triggers/backfill derive the
//      same canonical `delivery_status` as the S1 read models (app/deliveryUnitStatus.ts) and the same
//      `dispatch_status` as the TS `dispatchStatusForDelivery` (the SQL and TS lowerings agree).
//   3. IDENTITY — the derived `unit_id` matches the TS `*UnitId` helpers, and an epic slice node hangs
//      under its epic (`parent_unit_id`), so the aggregate's universal key is what the door will name.
//   4. COMPAT-VIEW PARITY — each legacy-shaped `<table>__units` VIEW is row-for-row identical to its
//      base table over insert/update/delete, so a read path can swap onto the aggregate losslessly.
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { applyMigrationSet, readMigrationSetFromDisk } from "#test-migrations";
import { assert, assertEquals } from "#test-assert";
import {
  DELIVERY_UNIT_KINDS,
  deliveryGraphUnitId,
  dispatchStatusForDelivery,
  epicUnitId,
  featureUnitId,
  planTaskUnitId,
} from "./deliveryUnit.ts";
import {
  type DeliveryUnitStatus,
  deliveryGraphDeliveryStatus,
  featureDeliveryStatus,
  planDeliveryStatus,
  PLAN_STATUSES,
  planTaskDeliveryStatus,
  toDeliveryUnitStatus,
} from "./deliveryUnitStatus.ts";
import { DELIVERY_GRAPH_RUN_STATUSES } from "./deliveryGraphRun.ts";
import { FEATURE_RUN_STATUSES } from "./feature.ts";
import { PLAN_TASK_STATUSES } from "./plan.ts";

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  applyMigrationSet(db, readMigrationSetFromDisk());
  return db;
}

const NOW = "2026-01-01T00:00:00Z";
const row = (db: DatabaseSync, sql: string, ...p: unknown[]) => db.prepare(sql).get(...(p as never[])) as Record<string, unknown>;
const rows = (db: DatabaseSync, sql: string, ...p: unknown[]) => db.prepare(sql).all(...(p as never[])) as Record<string, unknown>[];
const exec = (db: DatabaseSync, sql: string, ...p: unknown[]) => db.prepare(sql).run(...(p as never[]));

test("VOCABULARY PARITY: DELIVERY_UNIT_KINDS matches migration 088's CHECK (kind IN (…))", () => {
  const mig = readMigrationSetFromDisk().find((m) => m.name === "088_delivery_units.sql");
  assert(mig, "088_delivery_units.sql must exist");
  const m = mig.sql.match(/kind IN \(([^)]*)\)/);
  assert(m, "088 must declare a CHECK (kind IN (…)) constraint");
  const declared = m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
  assertEquals(declared, [...DELIVERY_UNIT_KINDS], "the SQL kind enum and the TS enum must agree");
});

test("DERIVATION PARITY: feature triggers derive the S1 canonical + dispatch status for every source status", () => {
  const db = freshDb();
  FEATURE_RUN_STATUSES.forEach((status, i) => {
    const key = `o/r#${100 + i}`;
    exec(
      db,
      `INSERT INTO feature_runs(feature_key,repo,issue_number,issue_url,base_branch,status,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?)`,
      key, "o/r", 100 + i, "u", "main", status, NOW, NOW,
    );
    const u = row(db, "SELECT * FROM delivery_units WHERE unit_id=?", featureUnitId(key));
    const canonical = toDeliveryUnitStatus(featureDeliveryStatus, status) as DeliveryUnitStatus;
    assertEquals(u.kind, "feature");
    assertEquals(u.delivery_status, canonical, `feature ${status} → canonical`);
    assertEquals(u.dispatch_status, dispatchStatusForDelivery(canonical), `feature ${status} → dispatch`);
    assertEquals(u.status, status, "raw legacy status is preserved verbatim");
  });
});

test("DERIVATION PARITY: epic (plans) triggers derive the S1 canonical + dispatch status for every source status", () => {
  const db = freshDb();
  PLAN_STATUSES.forEach((status, i) => {
    const key = `o/r#${200 + i}`;
    exec(
      db,
      `INSERT INTO plans(plan_key,repo,issue_number,issue_url,status,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?)`,
      key, "o/r", 200 + i, "u", status, NOW, NOW,
    );
    const u = row(db, "SELECT * FROM delivery_units WHERE unit_id=?", epicUnitId(key));
    const canonical = toDeliveryUnitStatus(planDeliveryStatus, status) as DeliveryUnitStatus;
    assertEquals(u.kind, "epic");
    assertEquals(u.delivery_status, canonical, `epic ${status} → canonical`);
    assertEquals(u.dispatch_status, dispatchStatusForDelivery(canonical), `epic ${status} → dispatch`);
  });
});

test("DERIVATION PARITY + IDENTITY: plan-task nodes derive status and hang under their epic", () => {
  const db = freshDb();
  const planKey = "o/r#300";
  exec(
    db,
    `INSERT INTO plans(plan_key,repo,issue_number,issue_url,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`,
    planKey, "o/r", 300, "u", "dispatched", NOW, NOW,
  );
  PLAN_TASK_STATUSES.forEach((status, i) => {
    exec(
      db,
      `INSERT INTO plan_tasks(plan_key,task_index,task_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?)`,
      planKey, i, `t${i}`, status, NOW, NOW,
    );
    const u = row(db, "SELECT * FROM delivery_units WHERE unit_id=?", planTaskUnitId(planKey, i));
    const canonical = toDeliveryUnitStatus(planTaskDeliveryStatus, status) as DeliveryUnitStatus;
    assertEquals(u.kind, "plan-task");
    assertEquals(u.delivery_status, canonical, `plan-task ${status} → canonical`);
    assertEquals(u.dispatch_status, dispatchStatusForDelivery(canonical), `plan-task ${status} → dispatch`);
    assertEquals(u.parent_unit_id, epicUnitId(planKey), "a node hangs under its epic composition");
    assertEquals(u.node_index, i, "the node carries its slice ordinal");
  });
});

test("DERIVATION PARITY: delivery-graph triggers derive the S1 canonical + dispatch status for every source status", () => {
  const db = freshDb();
  DELIVERY_GRAPH_RUN_STATUSES.forEach((status, i) => {
    const key = `dg${i}`;
    exec(
      db,
      `INSERT INTO delivery_graph_runs(run_key,digest,status,created_at,updated_at) VALUES(?,?,?,?,?)`,
      key, "abc", status, NOW, NOW,
    );
    const u = row(db, "SELECT * FROM delivery_units WHERE unit_id=?", deliveryGraphUnitId(key));
    const canonical = toDeliveryUnitStatus(deliveryGraphDeliveryStatus, status) as DeliveryUnitStatus;
    assertEquals(u.kind, "delivery-graph");
    assertEquals(u.delivery_status, canonical, `delivery-graph ${status} → canonical`);
    assertEquals(u.dispatch_status, dispatchStatusForDelivery(canonical), `delivery-graph ${status} → dispatch`);
  });
});

// ── COMPAT-VIEW PARITY — each `<table>__units` VIEW is byte-identical to its base table. ────────────
const norm = (r: Record<string, unknown>[]) =>
  JSON.stringify(r.map((x) => Object.fromEntries(Object.entries(x).sort())));

function assertViewParity(db: DatabaseSync, base: string, view: string) {
  assertEquals(norm(rows(db, `SELECT * FROM ${base} ORDER BY 1`)), norm(rows(db, `SELECT * FROM ${view} ORDER BY 1`)), `${view} must equal ${base}`);
}

test("COMPAT-VIEW PARITY: every legacy surface is served row-for-row from the aggregate across insert/update/delete", () => {
  const db = freshDb();
  exec(
    db,
    `INSERT INTO feature_runs(feature_key,repo,issue_number,issue_url,base_branch,status,converge,auto_merge,outcome,delivery_label,title,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    "o/r#1", "o/r", 1, "u", "main", "running", 1, 0, null, null, "Feat", NOW, NOW,
  );
  exec(
    db,
    `INSERT INTO plans(plan_key,repo,issue_number,issue_url,title,status,task_count,base_branch,epic_phase,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    "o/r#2", "o/r", 2, "u", "Epic", "planning", 2, "main", "Planning", NOW, NOW,
  );
  exec(
    db,
    `INSERT INTO plan_tasks(plan_key,task_index,task_id,title,prompt,status,pr_key,summary,wave,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    "o/r#2", 0, "t0", "Slice", "do it", "pending", null, null, 1, NOW, NOW,
  );
  exec(
    db,
    `INSERT INTO delivery_graph_runs(run_key,process_key,digest,status,side_effecting,node_count,human_node_count,side_effect_count,title,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    "dg1", null, "deadbeef", "awaiting-approval", 1, 5, 2, 3, "Graph", NOW, NOW,
  );

  const pairs: [string, string][] = [
    ["feature_runs", "feature_runs__units"],
    ["plans", "plans__units"],
    ["plan_tasks", "plan_tasks__units"],
    ["delivery_graph_runs", "delivery_graph_runs__units"],
  ];
  for (const [b, v] of pairs) assertViewParity(db, b, v);

  // UPDATE — a status transition (and a projected column) must re-project onto the aggregate.
  exec(db, "UPDATE feature_runs SET status=?, pr_key=?, updated_at=? WHERE feature_key=?", "merged", "o/r#5", "2026-02", "o/r#1");
  const fu = row(db, "SELECT delivery_status, dispatch_status FROM delivery_units WHERE unit_id=?", featureUnitId("o/r#1"));
  assertEquals(fu.delivery_status, "merged");
  assertEquals(fu.dispatch_status, "settled");
  for (const [b, v] of pairs) assertViewParity(db, b, v);

  // DELETE — the aggregate row is dropped with the legacy row.
  exec(db, "DELETE FROM plan_tasks WHERE plan_key=?", "o/r#2");
  assertEquals(rows(db, "SELECT * FROM delivery_units WHERE kind='plan-task'").length, 0, "deleting a slice drops its node unit");
  assertViewParity(db, "plan_tasks", "plan_tasks__units");
});
