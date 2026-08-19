// Regression guard for migration 049 (issue #324, ADR 0062 Slice 4/5, the WORLD half): the durable
// constraints that MAKE world-restore correct. The `UNIQUE(pr_key, idempotency_key)` on
// `world_effects` IS the fence — an effect recorded once cannot be double-applied — and the
// `UNIQUE(pr_key, checkpoint_offset)` on `world_checkpoints` guarantees one world per turn boundary.
// The tables are deliberately FK-FREE (like the 045 admission-staging twins): a checkpoint may be
// recorded for an in-flight PR whose `pull_requests` row a store desync momentarily lost.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertThrows } from "#test-assert";

function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  // Deliberately NO `pull_requests` table — the world tables must apply and accept rows with no PR
  // parent (FK-free by design).
  const sql = readFileSync(fileURLToPath(new URL("../db/migrations/049_world_checkpoint.sql", import.meta.url)), "utf8");
  db.exec(sql);
  return db;
}

const insertCheckpoint = (db: DatabaseSync, prKey: string, offset: number, sha: string) =>
  db
    .prepare(
      `INSERT INTO world_checkpoints (pr_key, round_no, checkpoint_offset, commit_sha, created_at)
       VALUES (?, 1, ?, ?, 't')`,
    )
    .run(prKey, offset, sha);

const insertEffect = (db: DatabaseSync, prKey: string, key: string) =>
  db
    .prepare(
      `INSERT INTO world_effects (pr_key, checkpoint_offset, seq, kind, idempotency_key, applied, created_at)
       VALUES (?, 0, 0, 'push', ?, 1, 't')`,
    )
    .run(prKey, key);

test("migration 049 applies cleanly with NO pull_requests table (FK-free) and records a checkpoint", () => {
  const db = migratedDb();
  insertCheckpoint(db, "o/r#2", 0, "sha-a"); // no PR parent — must NOT FK-fail
  const row = db.prepare("SELECT pr_key, commit_sha FROM world_checkpoints WHERE pr_key = ?").get("o/r#2") as {
    pr_key: string;
    commit_sha: string;
  };
  assertEquals(row.pr_key, "o/r#2");
  assertEquals(row.commit_sha, "sha-a");
});

test("world_checkpoints UNIQUE(pr_key, checkpoint_offset): one world per turn boundary", () => {
  const db = migratedDb();
  insertCheckpoint(db, "o/r#1", 0, "sha-a");
  assertThrows(
    () => insertCheckpoint(db, "o/r#1", 0, "sha-b"),
    undefined,
    "UNIQUE constraint failed",
  );
  // A different offset for the same PR, and the same offset for a different PR, are both fine.
  insertCheckpoint(db, "o/r#1", 1, "sha-b");
  insertCheckpoint(db, "o/r#2", 0, "sha-c");
  assertEquals(Number((db.prepare("SELECT COUNT(*) c FROM world_checkpoints").get() as { c: number }).c), 3);
});

test("world_effects UNIQUE(pr_key, idempotency_key) IS the fence: one real effect → one row", () => {
  const db = migratedDb();
  insertEffect(db, "o/r#1", "sha-a");
  assertThrows(
    () => insertEffect(db, "o/r#1", "sha-a"),
    undefined,
    "UNIQUE constraint failed",
  );
  // The SAME key under a DIFFERENT PR is a different effect — allowed.
  insertEffect(db, "o/r#2", "sha-a");
  const rows = db.prepare("SELECT pr_key FROM world_effects WHERE idempotency_key = ?").all("sha-a");
  assertEquals(rows.length, 2, "the fence is scoped per PR");
});

test("world_effects.applied defaults to 0 (a pending tail entry) unless set", () => {
  const db = migratedDb();
  db.prepare(
    `INSERT INTO world_effects (pr_key, checkpoint_offset, seq, kind, idempotency_key, created_at)
     VALUES ('o/r#1', 0, 0, 'pr-comment', 'c-1', 't')`,
  ).run();
  const row = db.prepare("SELECT applied FROM world_effects WHERE idempotency_key = 'c-1'").get() as { applied: number };
  assertEquals(row.applied, 0, "an effect recorded before it is performed is pending by default");
  assert(true);
});

test("world_effects CHECK(applied IN (0,1)): the fence's boolean domain is pinned at the schema", () => {
  const db = migratedDb();
  // The fence reads `applied` as "already realised?" — a stray value (a future writer bug or a
  // corrupt row on this externalised durability boundary) must be rejected, not silently mis-skip
  // or re-apply an effect on replay.
  assertThrows(
    () =>
      db
        .prepare(
          `INSERT INTO world_effects (pr_key, checkpoint_offset, seq, kind, idempotency_key, applied, created_at)
           VALUES ('o/r#1', 0, 0, 'push', 'sha-bad', 2, 't')`,
        )
        .run(),
    undefined,
    "CHECK constraint failed",
  );
  // The two legal values both insert fine.
  insertEffect(db, "o/r#1", "sha-applied"); // applied = 1
  db.prepare(
    `INSERT INTO world_effects (pr_key, checkpoint_offset, seq, kind, idempotency_key, applied, created_at)
     VALUES ('o/r#1', 0, 1, 'push', 'sha-pending', 0, 't')`,
  ).run();
  assertEquals(Number((db.prepare("SELECT COUNT(*) c FROM world_effects").get() as { c: number }).c), 2);
});
