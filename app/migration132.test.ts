// Migration guard for 132_pull_requests_merge_policy.sql (issue #947): the durable merge-policy
// projection `/status` serves. Applies the migration to a real in-memory SQLite DB over a
// pre-existing `pull_requests` table and asserts the expand-and-contract contract:
//   * both columns are added NULLABLE with no default — a pre-existing row reads
//     `merge_requested IS NULL` (the legacy marker `activePrs` falls back to the #937 batched
//     engine read for), never a fabricated 0/1;
//   * the writers' stamped values round-trip (0/1 for `merge_requested`, NULL/0/1 for
//     `merge_human_approval`).
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertEquals } from "#test-assert";

const MIGRATION_132 = fileURLToPath(
  new URL("../db/migrations/132_pull_requests_merge_policy.sql", import.meta.url),
);

function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE pull_requests (
       pr_key TEXT PRIMARY KEY,
       repo TEXT NOT NULL,
       number INTEGER NOT NULL,
       status TEXT NOT NULL,
       process_key TEXT
     );
     INSERT INTO pull_requests (pr_key, repo, number, status, process_key)
       VALUES ('owner/repo#1', 'owner/repo', 1, 'converging', 'PI-1');`,
  );
  db.exec(readFileSync(MIGRATION_132, "utf8"));
  return db;
}

test("migration 132 adds both merge-policy columns NULLABLE — a pre-existing row reads legacy (NULL)", () => {
  const db = migratedDb();
  // node:sqlite rows are null-prototype objects; spread to a plain object for the deep-equal.
  const row = {
    ...(db
      .prepare(`SELECT merge_requested, merge_human_approval FROM pull_requests WHERE pr_key = 'owner/repo#1'`)
      .get() as { merge_requested: number | null; merge_human_approval: number | null }),
  };
  assertEquals(
    row,
    { merge_requested: null, merge_human_approval: null },
    "a row written before the projection existed must NOT be back-filled — NULL is the legacy marker the /status fallback keys on",
  );
});

test("migration 132 columns round-trip the writers' stamped values", () => {
  const db = migratedDb();
  db.prepare(
    `UPDATE pull_requests SET merge_requested = 1, merge_human_approval = 0 WHERE pr_key = 'owner/repo#1'`,
  ).run();
  const row = {
    ...(db
      .prepare(`SELECT merge_requested, merge_human_approval FROM pull_requests WHERE pr_key = 'owner/repo#1'`)
      .get() as { merge_requested: number | null; merge_human_approval: number | null }),
  };
  assertEquals(row, { merge_requested: 1, merge_human_approval: 0 });
  // A review-only run stamps 0; the approval gate stamps 1 while outstanding.
  db.prepare(
    `UPDATE pull_requests SET merge_requested = 0, merge_human_approval = 1 WHERE pr_key = 'owner/repo#1'`,
  ).run();
  const gated = {
    ...(db
      .prepare(`SELECT merge_requested, merge_human_approval FROM pull_requests WHERE pr_key = 'owner/repo#1'`)
      .get() as { merge_requested: number | null; merge_human_approval: number | null }),
  };
  assertEquals(gated, { merge_requested: 0, merge_human_approval: 1 });
});
