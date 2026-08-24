// Read-model guard for migration 079's extended `lineage_thread_view` VIEW (issue #498: surface
// delivery-graph runs in the Lineage tab as a fan-in parent thread). Mirrors app/migration064.test.ts:
// apply the migration to a real in-memory SQLite DB and assert the VIEW's output over sample rows —
// so this exercises the real view, not a re-implementation.
//
// The extended view adds a third origin arm: a root that matches a `delivery_graph_runs.run_key`
// derives `kind = 'delivery'`, `title` from the run, and a NULL `issue_url` (a run is keyed by
// run_key/digest, not a GitHub issue). The epic/feature/pr arms must keep behaving exactly as 064's
// view did (precedence unchanged).
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertEquals } from "#test-assert";

const MIGRATION_064 = fileURLToPath(new URL("../db/migrations/064_lineage_thread_view.sql", import.meta.url));
const MIGRATION_079 = fileURLToPath(
  new URL("../db/migrations/079_lineage_thread_view_delivery.sql", import.meta.url),
);

/** A DB with the base shapes the view reads (`lineage_threads`, `plans`, `feature_runs`,
 *  `delivery_graph_runs`) plus 064 then 079 applied in order — so this exercises the real DROP VIEW +
 *  re-CREATE the migration performs, not just the final definition. */
function viewDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE lineage_threads (
       root_request_key TEXT PRIMARY KEY, title TEXT, stage TEXT,
       stage_label TEXT, process_key TEXT, pr_keys TEXT, pr_count INTEGER, active INTEGER,
       created_at TEXT, updated_at TEXT);
     CREATE TABLE plans (plan_key TEXT PRIMARY KEY, title TEXT, issue_url TEXT);
     CREATE TABLE feature_runs (feature_key TEXT PRIMARY KEY, title TEXT, issue_url TEXT);
     CREATE TABLE delivery_graph_runs (run_key TEXT PRIMARY KEY, title TEXT, phase TEXT, status TEXT);`,
  );
  db.exec(readFileSync(MIGRATION_064, "utf8"));
  db.exec(readFileSync(MIGRATION_079, "utf8"));
  return db;
}

/** Insert a `lineage_threads` row exactly as `pollLineage` denormalises one (post-072 schema — no
 *  `kind`/`issue_url` columns; the view derives both from the origin joins). */
function addThread(
  db: DatabaseSync,
  row: {
    root_request_key: string;
    title: string | null;
    stage: string;
    stage_label: string | null;
    process_key: string | null;
    pr_keys: string | null;
    pr_count: number;
    active: number;
  },
): void {
  db.prepare(
    `INSERT INTO lineage_threads (root_request_key, title, stage, stage_label,
       process_key, pr_keys, pr_count, active, created_at, updated_at)
     VALUES (@root_request_key, @title, @stage, @stage_label, @process_key,
       @pr_keys, @pr_count, @active, 't0', 't1')`,
  ).run(row);
}

test("lineage_thread_view derives kind/title/NULL issue_url for a delivery-graph thread from the run origin", () => {
  const db = viewDb();
  db.prepare(
    "INSERT INTO delivery_graph_runs (run_key, title, phase, status) VALUES (?, ?, ?, ?)",
  ).run("dg-abc123", "Ship widget across repos", "Parked on human node: manual OTP publish", "running");
  // pollLineage wrote the fan-in run's procedural frontier onto lineage_threads, keyed on run_key.
  addThread(db, {
    root_request_key: "dg-abc123",
    title: "Ship widget across repos",
    stage: "converging",
    stage_label: "Parked on human node: manual OTP publish",
    process_key: "P-dg",
    pr_keys: '["a/b#1","c/d#9"]',
    pr_count: 2,
    active: 1,
  });

  const v = db
    .prepare("SELECT * FROM lineage_thread_view WHERE root_request_key = ?")
    .get("dg-abc123") as Record<string, unknown>;
  // Derived from the delivery_graph_runs join.
  assertEquals(v.kind, "delivery");
  assertEquals(v.title, "Ship widget across repos");
  // A run is keyed by run_key/digest, not a GitHub issue — issue_url is always NULL.
  assertEquals(v.issue_url, null);
  // Procedural frontier columns pass through unchanged from lineage_threads (the run's derived phase).
  assertEquals(v.stage, "converging");
  assertEquals(v.stage_label, "Parked on human node: manual OTP publish");
  assertEquals(v.process_key, "P-dg");
  assertEquals(v.pr_keys, '["a/b#1","c/d#9"]');
  assertEquals(v.pr_count, 2);
  assertEquals(v.active, 1);
});

test("lineage_thread_view renders a delivery thread with no PR landed yet (empty member set, run phase)", () => {
  const db = viewDb();
  db.prepare(
    "INSERT INTO delivery_graph_runs (run_key, title, phase, status) VALUES (?, ?, ?, ?)",
  ).run("dg-empty", "Fresh run", "Running", "running");
  addThread(db, {
    root_request_key: "dg-empty",
    title: "Fresh run",
    stage: "implementing",
    stage_label: "Running",
    process_key: "P-e",
    pr_keys: "[]",
    pr_count: 0,
    active: 1,
  });

  const v = db
    .prepare("SELECT kind, title, issue_url, stage_label, pr_count FROM lineage_thread_view WHERE root_request_key = ?")
    .get("dg-empty") as Record<string, unknown>;
  assertEquals(v.kind, "delivery");
  assertEquals(v.title, "Fresh run");
  assertEquals(v.issue_url, null);
  assertEquals(v.stage_label, "Running");
  assertEquals(v.pr_count, 0);
});

test("lineage_thread_view keeps the epic/feature/pr arms unchanged after the delivery arm is added", () => {
  const db = viewDb();
  db.prepare("INSERT INTO plans (plan_key, title, issue_url) VALUES ('o/r#2', 'Epic', 'u-epic')").run();
  db.prepare("INSERT INTO feature_runs (feature_key, title, issue_url) VALUES ('o/r#1', 'Feat', 'u-feat')").run();
  const rows = [
    { root_request_key: "o/r#2", kind: "epic", title: "Epic", issue_url: "u-epic" },
    { root_request_key: "o/r#1", kind: "feature", title: "Feat", issue_url: "u-feat" },
    { root_request_key: "o/r#30", kind: "pr", title: "PR", issue_url: null },
  ];
  for (const r of rows) {
    addThread(db, {
      root_request_key: r.root_request_key,
      title: r.title,
      stage: "opened",
      stage_label: "Opened",
      process_key: null,
      pr_keys: "[]",
      pr_count: 1,
      active: 1,
    });
  }

  for (const r of rows) {
    const v = db
      .prepare("SELECT kind, title, issue_url FROM lineage_thread_view WHERE root_request_key = ?")
      .get(r.root_request_key) as Record<string, unknown>;
    assertEquals(v.kind, r.kind);
    assertEquals(v.title, r.title);
    assertEquals(v.issue_url, r.issue_url);
  }
});
