// Regression guard for migration 042 (issue #299): the promotion columns on `plans`. Proves the
// migration applies cleanly onto the pre-#299 `plans` shape and that a landed epic can record its
// promotion PR + state.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertEquals } from "#test-assert";

function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  // Minimal pre-#299 `plans` shape the migration extends (only the columns this test touches).
  db.exec(
    "CREATE TABLE plans (plan_key TEXT PRIMARY KEY, base_branch TEXT, delivery TEXT, delivery_label TEXT);",
  );
  db.prepare("INSERT INTO plans (plan_key, base_branch, delivery) VALUES (?, ?, ?)").run(
    "o/r#295",
    "epic/test-dsl",
    "landed",
  );
  const sql = readFileSync(
    fileURLToPath(new URL("../db/migrations/042_plan_promotion.sql", import.meta.url)),
    "utf8",
  );
  db.exec(sql);
  return db;
}

test("migration 042 applies cleanly and adds nullable promotion columns", () => {
  const db = migratedDb();
  const row = db
    .prepare("SELECT promotion_pr, promotion_state FROM plans WHERE plan_key = ?")
    .get("o/r#295") as { promotion_pr: string | null; promotion_state: string | null };
  // Grandfathered: both columns default to NULL on the existing row.
  assertEquals(row.promotion_pr, null);
  assertEquals(row.promotion_state, null);
});

test("migration 042 lets a landed epic record its promotion PR + state", () => {
  const db = migratedDb();
  db.prepare("UPDATE plans SET promotion_pr = ?, promotion_state = ? WHERE plan_key = ?").run(
    "o/r#500",
    "open",
    "o/r#295",
  );
  const row = db
    .prepare("SELECT promotion_pr, promotion_state FROM plans WHERE plan_key = ?")
    .get("o/r#295") as { promotion_pr: string; promotion_state: string };
  assertEquals(row.promotion_pr, "o/r#500");
  assertEquals(row.promotion_state, "open");
});
