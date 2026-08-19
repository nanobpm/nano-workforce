// Regression guard for migration 052 (issue #325, ADR 0062 Slice 5/5): the durable `durable-resume`
// enrolment registry. The table is FK-free (enrolment is per-worker and connection-agnostic, with no
// `pull_requests`/`plans` parent), the `instance` PRIMARY KEY makes `recordEnrolment` an idempotent
// upsert, and `CHECK(durable_resume IN (0,1))` pins the gate's boolean domain.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertEquals, assertThrows } from "#test-assert";

function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  // Deliberately NO parent tables — the enrolment table must apply and accept rows on a bare db.
  const sql = readFileSync(fileURLToPath(new URL("../db/migrations/052_worker_durable_resume.sql", import.meta.url)), "utf8");
  db.exec(sql);
  return db;
}

const upsert = (db: DatabaseSync, instance: string, flag: number) =>
  db
    .prepare(
      `INSERT INTO worker_durable_resume (instance, durable_resume, updated_at) VALUES (?, ?, 't')
       ON CONFLICT(instance) DO UPDATE SET durable_resume = excluded.durable_resume`,
    )
    .run(instance, flag);

test("migration 052 applies cleanly with NO parent tables (FK-free) and records an enrolment", () => {
  const db = migratedDb();
  upsert(db, "w1", 1);
  const row = db.prepare("SELECT instance, durable_resume FROM worker_durable_resume WHERE instance = ?").get("w1") as {
    instance: string;
    durable_resume: number;
  };
  assertEquals(row.instance, "w1");
  assertEquals(row.durable_resume, 1);
});

test("instance PRIMARY KEY makes a re-enrol an upsert (one row per worker, latest flag wins)", () => {
  const db = migratedDb();
  upsert(db, "w1", 1);
  upsert(db, "w1", 0);
  const count = Number((db.prepare("SELECT COUNT(*) c FROM worker_durable_resume").get() as { c: number }).c);
  assertEquals(count, 1, "no duplicate row for one instance");
  const row = db.prepare("SELECT durable_resume FROM worker_durable_resume WHERE instance = 'w1'").get() as { durable_resume: number };
  assertEquals(row.durable_resume, 0, "the latest enrolment flag wins");
});

test("durable_resume defaults to 0 (a non-participant) when unset", () => {
  const db = migratedDb();
  db.prepare("INSERT INTO worker_durable_resume (instance, updated_at) VALUES ('w1', 't')").run();
  const row = db.prepare("SELECT durable_resume FROM worker_durable_resume WHERE instance = 'w1'").get() as { durable_resume: number };
  assertEquals(row.durable_resume, 0);
});

test("CHECK(durable_resume IN (0,1)): the gate's boolean domain is pinned at the schema", () => {
  const db = migratedDb();
  assertThrows(
    () => db.prepare("INSERT INTO worker_durable_resume (instance, durable_resume, updated_at) VALUES ('w1', 2, 't')").run(),
    undefined,
    "CHECK constraint failed",
  );
  upsert(db, "yes", 1);
  upsert(db, "no", 0);
  assertEquals(Number((db.prepare("SELECT COUNT(*) c FROM worker_durable_resume").get() as { c: number }).c), 2);
});
