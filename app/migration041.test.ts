// Regression guard for migration 041 (issue #292 slice S1): the durable constraints on the INTER-epic
// `plan_deps` table. The app-layer accessors (app/planDeps.test.ts) enforce self-edge / duplicate
// rejection for the in-memory data layer; this test proves the SCHEMA itself is the backstop — the
// migration applies cleanly, a self-edge trips the CHECK, a duplicate consumer→producer pair trips
// the PRIMARY KEY, and the consumer `plan_key` foreign-keys to an admitted plan.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertEquals } from "#test-assert";

function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  // Minimal `plans` shape the migration's FK references.
  db.exec("CREATE TABLE plans (plan_key TEXT PRIMARY KEY);");
  for (const k of ["o/r#1", "o/r#2", "o/r#3"]) {
    db.prepare("INSERT INTO plans (plan_key) VALUES (?)").run(k);
  }
  const sql = readFileSync(
    fileURLToPath(new URL("../db/migrations/041_inter_epic_plan_deps.sql", import.meta.url)),
    "utf8",
  );
  db.exec(sql);
  return db;
}

const insert = (db: DatabaseSync, planKey: string, dependsOn: string) =>
  db
    .prepare(
      `INSERT INTO plan_deps (plan_key, depends_on_plan_key, package, capability_ref, created_at)
       VALUES (?, ?, '@nanobpm/p', ?, 't')`,
    )
    .run(planKey, dependsOn, dependsOn);

test("migration 041 applies cleanly and records a valid inter-epic edge", () => {
  const db = migratedDb();
  insert(db, "o/r#2", "o/r#1");
  const row = db
    .prepare("SELECT plan_key, depends_on_plan_key, package FROM plan_deps WHERE plan_key = ?")
    .get("o/r#2") as { plan_key: string; depends_on_plan_key: string; package: string };
  assertEquals(row.plan_key, "o/r#2");
  assertEquals(row.depends_on_plan_key, "o/r#1");
  assertEquals(row.package, "@nanobpm/p");
});

test("migration 041 CHECK rejects a self-edge", () => {
  const db = migratedDb();
  let threw = false;
  try {
    insert(db, "o/r#1", "o/r#1");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

test("migration 041 PRIMARY KEY rejects a duplicate consumer→producer edge", () => {
  const db = migratedDb();
  insert(db, "o/r#2", "o/r#1");
  let threw = false;
  try {
    insert(db, "o/r#2", "o/r#1");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

test("migration 041 FK ties the consumer plan_key to an admitted plan", () => {
  const db = migratedDb();
  let threw = false;
  try {
    insert(db, "o/r#404", "o/r#1");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
