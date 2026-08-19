// Regression guard for migration 045 (issue #292 slice S2): the durable constraints on the FK-FREE
// admission-staging tables `admitted_epics` / `admitted_plan_deps`. Its sibling migration041.test.ts
// proves `plan_deps` foreign-keys its consumer to an admitted `plans` row; this proves the staging
// twin is deliberately NOT FK-constrained — it must accept an edge (and an epic) whose plan row does
// not exist yet, since S2 stages BEFORE any `plans` row is materialized — while still rejecting a
// self-edge (CHECK) and a duplicate (PRIMARY KEY), exactly like `plan_deps`.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertEquals } from "#test-assert";

function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  // NOTE: deliberately NO `plans` table — the staging tables must apply and accept rows with no plan
  // graph in existence (that is the whole point of FK-free staging).
  const sql = readFileSync(
    fileURLToPath(new URL("../db/migrations/045_epic_set_admission_staging.sql", import.meta.url)),
    "utf8",
  );
  db.exec(sql);
  return db;
}

const insertEdge = (db: DatabaseSync, planKey: string, dependsOn: string) =>
  db
    .prepare(
      `INSERT INTO admitted_plan_deps (plan_key, depends_on_plan_key, package, capability_ref, created_at)
       VALUES (?, ?, '@nanobpm/p', ?, 't')`,
    )
    .run(planKey, dependsOn, dependsOn);

const insertEpic = (db: DatabaseSync, planKey: string) =>
  db
    .prepare(
      `INSERT INTO admitted_epics (plan_key, repo, issue_number, issue_url, base_branch, created_at)
       VALUES (?, 'o/r', 1, 'https://github.com/o/r/issues/1', 'epic/a', 't')`,
    )
    .run(planKey);

test("migration 045 applies cleanly with NO plans table (FK-free) and stages an edge", () => {
  const db = migratedDb();
  insertEdge(db, "o/r#2", "o/r#1"); // neither endpoint has a plans row — must NOT FK-fail
  const row = db
    .prepare("SELECT plan_key, depends_on_plan_key, package FROM admitted_plan_deps WHERE plan_key = ?")
    .get("o/r#2") as { plan_key: string; depends_on_plan_key: string; package: string };
  assertEquals(row.plan_key, "o/r#2");
  assertEquals(row.depends_on_plan_key, "o/r#1");
  assertEquals(row.package, "@nanobpm/p");
});

test("migration 045 stages an admitted epic with no plans row", () => {
  const db = migratedDb();
  insertEpic(db, "o/r#1");
  const row = db.prepare("SELECT plan_key, base_branch FROM admitted_epics WHERE plan_key = ?").get("o/r#1") as {
    plan_key: string;
    base_branch: string;
  };
  assertEquals(row.plan_key, "o/r#1");
  assertEquals(row.base_branch, "epic/a");
});

test("migration 045 CHECK rejects a self-edge", () => {
  const db = migratedDb();
  let threw = false;
  try {
    insertEdge(db, "o/r#1", "o/r#1");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

test("migration 045 PRIMARY KEY rejects a duplicate consumer→producer edge", () => {
  const db = migratedDb();
  insertEdge(db, "o/r#2", "o/r#1");
  let threw = false;
  try {
    insertEdge(db, "o/r#2", "o/r#1");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

test("migration 045 PRIMARY KEY rejects a duplicate staged epic", () => {
  const db = migratedDb();
  insertEpic(db, "o/r#1");
  let threw = false;
  try {
    insertEpic(db, "o/r#1");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
