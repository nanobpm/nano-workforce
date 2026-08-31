// Backfill coverage for the acknowledge-to-dismiss migrations (issue #641). The HIGHEST-RISK item:
// repointing the four "Active …" grids at the derived `list_bucket` — which folds an UNACKNOWLEDGED
// terminal row into `active` — would flood every historical terminal PR / delivery-graph run into
// Active on the next boot. Migrations 093 (PRs) and 095 (delivery graphs) prevent that by stamping
// `acknowledged_at` on every CURRENTLY-terminal row, so they load in History from day one, while rows
// that reach terminal AFTER the migration stay in Active until an operator dismisses them.
//
// This test reproduces the real upgrade path: apply the migration chain UP TO (but not including) the
// `acknowledged_at` additions, seed pre-existing rows the way a live DB carries them (terminal + live,
// NO acknowledged_at column yet), then apply the remaining migrations (093/094/095/096/097 …) and read
// the derived read-model VIEWs to prove the resulting Active/History partition.
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { applyMigrationSet, readMigrationSetFromDisk } from "../test/migrations.ts";

// The pre-`acknowledged_at` schema slice (everything numbered below 093, lexically) — the base
// `pull_requests` (001) and `delivery_graph_runs` (058) tables exist here, WITHOUT the dismissal stamp.
function migrationsBefore093() {
  return readMigrationSetFromDisk().filter((f) => f.name < "093");
}

function backfillDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const files = readMigrationSetFromDisk();
  // Phase 1: schema as it stood before the dismissal stamp.
  applyMigrationSet(db, migrationsBefore093());

  // Seed pre-existing rows exactly as a live DB carries them — no acknowledged_at column yet.
  const insPr = (pr_key: string, status: string) =>
    db
      .prepare(
        "INSERT INTO pull_requests (pr_key, repo, number, url, status, created_at, updated_at, merged_at) VALUES (?, 'o/r', 1, 'https://x', ?, '2025-01-01T00:00:00Z', '2025-06-01T00:00:00Z', ?)",
      )
      .run(pr_key, status, status === "merged" ? "2025-06-01T00:00:00Z" : null);
  // Terminal (must backfill → History) + live (must stay Active).
  for (const s of ["merged", "converged", "abandoned", "closed", "failed"]) insPr(`pre-${s}`, s);
  insPr("pre-live", "converging");

  const insDg = (run_key: string, status: string) =>
    db
      .prepare(
        "INSERT INTO delivery_graph_runs (run_key, digest, status, created_at, updated_at) VALUES (?, 'dig', ?, '2025-01-01T00:00:00Z', '2025-06-01T00:00:00Z')",
      )
      .run(run_key, status);
  for (const s of ["done", "failed", "abandoned"]) insDg(`pre-${s}`, s);
  insDg("pre-live", "running");

  // Phase 2: apply the remaining migrations — 093/095 add the column + backfill the pre-existing
  // terminal rows, 094/096 (re)create the read-model VIEWs. applyMigrationSet skips the already-applied.
  applyMigrationSet(db, files);

  // Stand-ins for the managed `<table>__tracking` derived VIEWs urban provisions at mount (pass-through
  // `derived_status := base.status`, modelling settled rows) — the read-model VIEWs read these.
  db.exec(
    `CREATE VIEW pull_requests__tracking AS SELECT p.*, p.status AS derived_status FROM pull_requests p;
     CREATE VIEW delivery_graph_runs__tracking AS SELECT d.*, d.status AS derived_status FROM delivery_graph_runs d;`,
  );

  // A row that reaches terminal AFTER the migration — acknowledged_at stays NULL, so it must stay Active.
  db.prepare(
    "INSERT INTO pull_requests (pr_key, repo, number, url, status, created_at, updated_at) VALUES ('post-merged', 'o/r', 2, 'https://y', 'merged', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
  ).run();
  db.prepare(
    "INSERT INTO delivery_graph_runs (run_key, digest, status, created_at, updated_at) VALUES ('post-done', 'dig', 'done', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
  ).run();
  return db;
}

function prBucket(db: DatabaseSync, pr_key: string) {
  return db.prepare("SELECT list_bucket, ack_open, acknowledged_at FROM pull_requests_read_model WHERE pr_key = ?").get(pr_key) as {
    list_bucket: string;
    ack_open: number;
    acknowledged_at: string | null;
  };
}
function dgBucket(db: DatabaseSync, run_key: string) {
  return db.prepare("SELECT list_bucket, ack_open, acknowledged_at FROM delivery_graph_read_model WHERE run_key = ?").get(run_key) as {
    list_bucket: string;
    ack_open: number;
    acknowledged_at: string | null;
  };
}

test("migration 093 backfill: every pre-existing terminal PR loads in History (acknowledged_at stamped); a live PR stays Active; a post-migration terminal PR stays Active until dismissed", () => {
  const db = backfillDb();
  for (const s of ["merged", "converged", "abandoned", "closed", "failed"]) {
    const b = prBucket(db, `pre-${s}`);
    assert(b.acknowledged_at !== null, `pre-existing terminal PR (${s}) must be backfilled with acknowledged_at`);
    assertEquals(b.list_bucket, "history", `pre-existing terminal PR (${s}) must load in History`);
    assertEquals(b.ack_open, 0);
  }
  // A live PR was never terminal → not backfilled → Active, no Dismiss.
  const live = prBucket(db, "pre-live");
  assertEquals(live.acknowledged_at, null);
  assertEquals(live.list_bucket, "active");
  // A PR that settled AFTER the migration is NOT auto-dismissed — stays Active with the Dismiss flag.
  const post = prBucket(db, "post-merged");
  assertEquals(post.acknowledged_at, null);
  assertEquals(post.list_bucket, "active");
  assertEquals(post.ack_open, 1);
  db.close();
});

test("migration 095 backfill: every pre-existing terminal delivery-graph run loads in History; a live run stays Active; a post-migration terminal run stays Active until dismissed", () => {
  const db = backfillDb();
  for (const s of ["done", "failed", "abandoned"]) {
    const b = dgBucket(db, `pre-${s}`);
    assert(b.acknowledged_at !== null, `pre-existing terminal run (${s}) must be backfilled with acknowledged_at`);
    assertEquals(b.list_bucket, "history", `pre-existing terminal run (${s}) must load in History`);
    assertEquals(b.ack_open, 0);
  }
  const live = dgBucket(db, "pre-live");
  assertEquals(live.acknowledged_at, null);
  assertEquals(live.list_bucket, "active");
  const post = dgBucket(db, "post-done");
  assertEquals(post.acknowledged_at, null);
  assertEquals(post.list_bucket, "active");
  assertEquals(post.ack_open, 1);
  db.close();
});
