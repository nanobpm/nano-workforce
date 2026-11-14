// Migration guard for 139_pull_requests_backfill_merged_not_abandoned.sql (issue #959): the backfill
// that re-derives the 23 merged-but-terminated PRs so they show as `merged`, not `abandoned`.
//
// Applies the migration to a real in-memory SQLite DB over a pre-existing `pull_requests` + `merges`
// shape and asserts the contract:
//   * a row with a `merged` audit outcome but a non-`merged` base status (the loop terminated before
//     `merged_at` was stamped) is settled to `status='merged'` + `merged_at` — so the merge-aware
//     derivation reports `merged` however the instance ended;
//   * a row already settled `merged` is left untouched (idempotent);
//   * a row with NO `merged` audit outcome (a genuinely abandoned/closed-unmerged run) is NOT
//     flipped — it stays at its frozen transient so the derivation still reports `abandoned`;
//   * re-running the migration is a no-op (forward-only, idempotent).
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertEquals } from "#test-assert";

const MIGRATION_139 = fileURLToPath(
  new URL("../db/migrations/139_pull_requests_backfill_merged_not_abandoned.sql", import.meta.url),
);

function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE pull_requests (
       pr_key TEXT PRIMARY KEY,
       repo TEXT NOT NULL,
       number INTEGER NOT NULL,
       status TEXT NOT NULL,
       process_key TEXT,
       merged_at TEXT,
       updated_at TEXT
     );
     CREATE TABLE merges (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       pr_key TEXT NOT NULL,
       outcome TEXT NOT NULL,
       method TEXT,
       detail TEXT,
       at TEXT NOT NULL
     );`,
  );
  return db;
}

function addPr(db: DatabaseSync, prKey: string, status: string, mergedAt: string | null = null): void {
  db.prepare(
    "INSERT INTO pull_requests (pr_key, repo, number, status, process_key, merged_at, updated_at) VALUES (?, 'o/r', 1, ?, 'PI-1', ?, 't0')",
  ).run(prKey, status, mergedAt);
}

function addMerge(db: DatabaseSync, prKey: string, outcome: string, at: string): void {
  db.prepare("INSERT INTO merges (pr_key, outcome, method, detail, at) VALUES (?, ?, 'squash', 'd', ?)").run(prKey, outcome, at);
}

function row(db: DatabaseSync, prKey: string): { status: string; merged_at: string | null } {
  return db.prepare("SELECT status, merged_at FROM pull_requests WHERE pr_key = ?").get(prKey) as {
    status: string;
    merged_at: string | null;
  };
}

const SQL = () => readFileSync(MIGRATION_139, "utf8");

test("139 backfills a merged-but-terminated PR (frozen transient + merged audit) to status='merged' + merged_at", () => {
  const db = migratedDb();
  // The #959 case: PR landed (merged audit row) but the loop was terminated before merged_at was set,
  // leaving the base status frozen at its in-flight transient.
  addPr(db, "o/r#landed", "converging", null);
  addMerge(db, "o/r#landed", "merged", "2026-11-01T02:03:04Z");
  db.exec(SQL());
  const r = row(db, "o/r#landed");
  assertEquals(r.status, "merged");
  assertEquals(r.merged_at, "2026-11-01T02:03:04Z", "merged_at is stamped from the earliest merged audit row");
  db.close();
});

test("139 leaves an already-merged row untouched (idempotent, never overwrites merged_at)", () => {
  const db = migratedDb();
  addPr(db, "o/r#already", "merged", "2026-10-30T00:00:00Z");
  addMerge(db, "o/r#already", "merged", "2026-10-30T00:00:00Z");
  db.exec(SQL());
  const r = row(db, "o/r#already");
  assertEquals(r.status, "merged");
  assertEquals(r.merged_at, "2026-10-30T00:00:00Z");
  db.close();
});

test("139 does NOT flip a closed-unmerged / genuinely-abandoned PR (no merged audit outcome)", () => {
  const db = migratedDb();
  // A PR closed without merging: terminated → abandoned, NO merged audit row. Must stay un-merged.
  addPr(db, "o/r#closed", "converging", null);
  addMerge(db, "o/r#closed", "abandoned", "2026-11-01T00:00:00Z");
  // A still-in-flight PR with no merge record at all.
  addPr(db, "o/r#inflight", "waiting_merge", null);
  db.exec(SQL());
  assertEquals(row(db, "o/r#closed").status, "converging", "no merged outcome → not flipped to merged");
  assertEquals(row(db, "o/r#closed").merged_at, null);
  assertEquals(row(db, "o/r#inflight").status, "waiting_merge");
  assertEquals(row(db, "o/r#inflight").merged_at, null);
  db.close();
});

test("139 is idempotent — a second run is a no-op", () => {
  const db = migratedDb();
  addPr(db, "o/r#landed", "waiting_merge", null);
  addMerge(db, "o/r#landed", "merged", "2026-11-01T02:03:04Z");
  db.exec(SQL());
  const first = row(db, "o/r#landed");
  db.exec(SQL());
  const second = row(db, "o/r#landed");
  assertEquals(second, first);
  db.close();
});
