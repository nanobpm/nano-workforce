// Regression guard for migration 147 (issue #1047): at most ONE `merged` audit row per PR. A stuck
// merge loop appended a `merged` row every cycle; 147 collapses the backlog (keeping the earliest
// row) and fences new duplicates with the partial UNIQUE index `ux_merges_merged_pr`.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertEquals, assertThrows } from "#test-assert";

const MIGRATION = fileURLToPath(new URL("../db/migrations/147_merges_merged_dedupe.sql", import.meta.url));

function baseDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE merges (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pr_key TEXT NOT NULL, outcome TEXT NOT NULL,
    method TEXT, detail TEXT, at TEXT NOT NULL
  );`);
  return db;
}

const ins = (db: DatabaseSync, pr: string, outcome: string, detail: string) =>
  db.prepare("INSERT INTO merges (pr_key, outcome, method, detail, at) VALUES (?, ?, 'squash', ?, 't')").run(pr, outcome, detail);

test("migration 147 dedupes existing merged rows, keeping the earliest per PR", () => {
  const db = baseDb();
  ins(db, "o/r#1", "merged", "first");
  ins(db, "o/r#1", "merged", "dup");
  ins(db, "o/r#1", "blocked", "b");
  ins(db, "o/r#1", "blocked", "b");
  ins(db, "o/r#2", "merged", "solo");
  db.exec(readFileSync(MIGRATION, "utf8"));
  const rows = db.prepare("SELECT pr_key, outcome, detail FROM merges ORDER BY id").all();
  assertEquals(
    rows.map((r) => `${r.pr_key}:${r.outcome}:${r.detail}`),
    ["o/r#1:merged:first", "o/r#1:blocked:b", "o/r#1:blocked:b", "o/r#2:merged:solo"],
  );
});

test("migration 147 fences a second merged row for the same PR", () => {
  const db = baseDb();
  db.exec(readFileSync(MIGRATION, "utf8"));
  ins(db, "o/r#1", "merged", "a");
  assertThrows(() => ins(db, "o/r#1", "merged", "b"), undefined, "UNIQUE constraint failed");
  ins(db, "o/r#2", "merged", "c");
  ins(db, "o/r#1", "queued", "q");
  ins(db, "o/r#1", "queued", "q");
});
