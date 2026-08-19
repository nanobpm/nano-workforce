// Regression guard for migration 053 (#352, PR #354 review — suppressed advisory on app/service.ts:867):
// the DB-level fence that makes `abandonClosedPr`'s terminal audit write TRULY idempotent under a
// concurrent race, not merely best-effort. The partial `UNIQUE INDEX ux_merges_abandon_pr_closed ON
// merges(pr_key) WHERE outcome='abandoned' AND method='pr-closed'` IS the fence: the merge worker and
// the wave-gate self-heal path can both observe "no row" between the guard's `find` and its `insert`
// and both attempt the write, and this index is what turns the loser's insert into a catchable
// `UNIQUE constraint failed` instead of a duplicate audit row.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertThrows } from "#test-assert";

// The `merges` audit table as created by 004_merge.sql, minus the `pull_requests` FK parent (this
// test proves the index behaviour in isolation, exactly as migration049.test.ts hosts the world
// tables FK-free). Then apply 053 on top.
function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE merges (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_key   TEXT NOT NULL,
    outcome  TEXT NOT NULL,
    method   TEXT,
    detail   TEXT,
    at       TEXT NOT NULL
  );`);
  const sql = readFileSync(fileURLToPath(new URL("../db/migrations/053_merges_abandon_dedupe.sql", import.meta.url)), "utf8");
  db.exec(sql);
  return db;
}

const insertAbandon = (db: DatabaseSync, prKey: string) =>
  db
    .prepare("INSERT INTO merges (pr_key, outcome, method, detail, at) VALUES (?, 'abandoned', 'pr-closed', 'd', 't')")
    .run(prKey);

test("migration 053 applies cleanly and enforces one abandoned/pr-closed row per pr_key", () => {
  const db = migratedDb();
  insertAbandon(db, "o/r#1");
  // The race: a second observer inserting the SAME abandoned/pr-closed row now hits the fence.
  assertThrows(() => insertAbandon(db, "o/r#1"), undefined, "UNIQUE constraint failed");
  assertEquals(
    Number((db.prepare("SELECT COUNT(*) c FROM merges WHERE pr_key='o/r#1'").get() as { c: number }).c),
    1,
    "the loser's duplicate was rejected — one terminal audit row survives",
  );
  // A DIFFERENT PR's abandon is independent — the index is per pr_key, not global.
  insertAbandon(db, "o/r#2");
  assertEquals(Number((db.prepare("SELECT COUNT(*) c FROM merges").get() as { c: number }).c), 2);
});

test("migration 053 only fences abandoned/pr-closed rows — merged/queued/blocked still repeat freely", () => {
  const db = migratedDb();
  const insertMerged = () =>
    db.prepare("INSERT INTO merges (pr_key, outcome, method, detail, at) VALUES ('o/r#3','merged','squash','d','t')").run();
  // A PR can carry several `merged` audit rows (retry / already-merged short-circuit) — the partial
  // index must NOT constrain them (mergesPerDay dedupes with COUNT(DISTINCT pr_key)).
  insertMerged();
  insertMerged();
  assertEquals(Number((db.prepare("SELECT COUNT(*) c FROM merges WHERE outcome='merged'").get() as { c: number }).c), 2);
  // An abandoned row with a DIFFERENT method is also outside the partial predicate.
  db.prepare("INSERT INTO merges (pr_key, outcome, method, detail, at) VALUES ('o/r#3','abandoned','other','d','t')").run();
  db.prepare("INSERT INTO merges (pr_key, outcome, method, detail, at) VALUES ('o/r#3','abandoned','other','d','t')").run();
  assertEquals(Number((db.prepare("SELECT COUNT(*) c FROM merges WHERE method='other'").get() as { c: number }).c), 2);
});

test("migration 053 collapses pre-existing duplicate abandoned/pr-closed rows, keeping the earliest", () => {
  // Simulate a database where the pre-fence race already wrote duplicates, then apply the migration.
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE merges (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pr_key TEXT NOT NULL, outcome TEXT NOT NULL,
    method TEXT, detail TEXT, at TEXT NOT NULL);`);
  db.prepare("INSERT INTO merges (pr_key,outcome,method,detail,at) VALUES ('o/r#9','abandoned','pr-closed','first','t')").run();
  db.prepare("INSERT INTO merges (pr_key,outcome,method,detail,at) VALUES ('o/r#9','abandoned','pr-closed','dup','t')").run();
  db.prepare("INSERT INTO merges (pr_key,outcome,method,detail,at) VALUES ('o/r#8','abandoned','pr-closed','solo','t')").run();
  const sql = readFileSync(fileURLToPath(new URL("../db/migrations/053_merges_abandon_dedupe.sql", import.meta.url)), "utf8");
  db.exec(sql); // dedupe + create index; must not throw despite the pre-existing duplicate
  const rows = db.prepare("SELECT pr_key, detail FROM merges ORDER BY pr_key").all() as { pr_key: string; detail: string }[];
  assertEquals(rows.length, 2, "the duplicate for o/r#9 was collapsed");
  assert(
    rows.some((r) => r.pr_key === "o/r#9" && r.detail === "first"),
    "the EARLIEST (MIN(id)) row survived the collapse",
  );
});
