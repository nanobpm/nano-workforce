// Read-model guard for migration 064's `lineage_thread_view` VIEW (epic #412: retire the
// worker-maintained `lineage_threads` denormalisation in favour of SQL VIEWs for the parts that are
// clean rollups). Mirrors the derived-read-model test style of app/migration037.test.ts and
// app/planWaveSummary.test.ts: apply the migration to a real in-memory SQLite DB and assert the
// VIEW's output over sample rows — so this exercises the real view, not a re-implementation.
//
// The view DERIVES the view-expressible identity columns (`kind`, `issue_url`, and an epic/feature
// thread's `title`) from the `plans` / `feature_runs` origin joins, and PASSES THROUGH the
// procedural frontier columns (`stage`/`stage_label`/`process_key`/`pr_keys`/`pr_count`/`active`/
// timestamps) from `lineage_threads`. It must reproduce EXACTLY what `pollLineage` wrote for the
// migrated columns, so a future drop of those `lineage_threads` columns is behaviour-preserving.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertEquals } from "#test-assert";

const MIGRATION = fileURLToPath(new URL("../db/migrations/064_lineage_thread_view.sql", import.meta.url));

/** A DB with the base shapes the view reads (`lineage_threads`, `plans`, `feature_runs`) plus the
 *  view applied. The `lineage_threads` schema also models `kind`/`issue_url`, which the view does
 *  NOT read (it derives them from the `plans`/`feature_runs` origin joins) — they are kept here so
 *  `addThread` can write exactly what `pollLineage` denormalises. */
function viewDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE lineage_threads (
       root_request_key TEXT PRIMARY KEY, kind TEXT, title TEXT, issue_url TEXT, stage TEXT,
       stage_label TEXT, process_key TEXT, pr_keys TEXT, pr_count INTEGER, active INTEGER,
       created_at TEXT, updated_at TEXT);
     CREATE TABLE plans (plan_key TEXT PRIMARY KEY, title TEXT, issue_url TEXT);
     CREATE TABLE feature_runs (feature_key TEXT PRIMARY KEY, title TEXT, issue_url TEXT);`,
  );
  db.exec(readFileSync(MIGRATION, "utf8"));
  return db;
}

/** Insert a `lineage_threads` row exactly as `pollLineage` denormalises one. */
function addThread(
  db: DatabaseSync,
  row: {
    root_request_key: string;
    kind: string;
    title: string | null;
    issue_url: string | null;
    stage: string;
    stage_label: string | null;
    process_key: string | null;
    pr_keys: string | null;
    pr_count: number;
    active: number;
  },
): void {
  db.prepare(
    `INSERT INTO lineage_threads (root_request_key, kind, title, issue_url, stage, stage_label,
       process_key, pr_keys, pr_count, active, created_at, updated_at)
     VALUES (@root_request_key, @kind, @title, @issue_url, @stage, @stage_label, @process_key,
       @pr_keys, @pr_count, @active, 't0', 't1')`,
  ).run(row);
}

test("lineage_thread_view derives kind/issue_url/title for an epic thread from the plans origin", () => {
  const db = viewDb();
  db.prepare("INSERT INTO plans (plan_key, title, issue_url) VALUES (?, ?, ?)").run(
    "o/r#2",
    "Epic: retire projections",
    "https://github.com/o/r/issues/2",
  );
  // pollLineage wrote the same identity values (denormalised) alongside the procedural frontier.
  addThread(db, {
    root_request_key: "o/r#2",
    kind: "epic",
    title: "Epic: retire projections",
    issue_url: "https://github.com/o/r/issues/2",
    stage: "converging",
    stage_label: "3/5 slices merged, 2 converging",
    process_key: "P-epic",
    pr_keys: '["o/r#20","o/r#21"]',
    pr_count: 5,
    active: 1,
  });

  const v = db
    .prepare("SELECT * FROM lineage_thread_view WHERE root_request_key = ?")
    .get("o/r#2") as Record<string, unknown>;
  // Derived from the plans join — identical to what the poller denormalised.
  assertEquals(v.kind, "epic");
  assertEquals(v.title, "Epic: retire projections");
  assertEquals(v.issue_url, "https://github.com/o/r/issues/2");
  // Procedural frontier columns pass through unchanged from lineage_threads.
  assertEquals(v.stage, "converging");
  assertEquals(v.stage_label, "3/5 slices merged, 2 converging");
  assertEquals(v.process_key, "P-epic");
  assertEquals(v.pr_keys, '["o/r#20","o/r#21"]');
  assertEquals(v.pr_count, 5);
  assertEquals(v.active, 1);
});

test("lineage_thread_view derives kind/issue_url/title for a feature thread from the feature_runs origin", () => {
  const db = viewDb();
  db.prepare("INSERT INTO feature_runs (feature_key, title, issue_url) VALUES (?, ?, ?)").run(
    "o/r#1",
    "Feature: add widget",
    "https://github.com/o/r/issues/1",
  );
  addThread(db, {
    root_request_key: "o/r#1",
    kind: "feature",
    title: "Feature: add widget",
    issue_url: "https://github.com/o/r/issues/1",
    stage: "merged",
    stage_label: "Merged",
    process_key: "P-feat",
    pr_keys: '["o/r#10"]',
    pr_count: 1,
    active: 0,
  });

  const v = db
    .prepare("SELECT * FROM lineage_thread_view WHERE root_request_key = ?")
    .get("o/r#1") as Record<string, unknown>;
  assertEquals(v.kind, "feature");
  assertEquals(v.title, "Feature: add widget");
  assertEquals(v.issue_url, "https://github.com/o/r/issues/1");
  assertEquals(v.stage, "merged");
  assertEquals(v.active, 0);
});

test("lineage_thread_view self-roots an origin-less PR: kind 'pr', NULL issue_url, title falls back to the poller value", () => {
  const db = viewDb();
  // No plans / feature_runs row for this root — it is a human/webhook PR that is its own root.
  addThread(db, {
    root_request_key: "o/r#30",
    kind: "pr",
    title: "hotfix: bump dep",
    issue_url: null,
    stage: "converging",
    stage_label: "Converging (round 2)",
    process_key: "P-pr",
    pr_keys: '["o/r#30"]',
    pr_count: 1,
    active: 1,
  });

  const v = db
    .prepare("SELECT * FROM lineage_thread_view WHERE root_request_key = ?")
    .get("o/r#30") as Record<string, unknown>;
  assertEquals(v.kind, "pr");
  // issue_url is always NULL for a self-rooted PR, exactly as deriveLineage sets it.
  assertEquals(v.issue_url, null);
  // The PR title is the procedural representative-PR pick, so it comes through from lineage_threads.
  assertEquals(v.title, "hotfix: bump dep");
  assertEquals(v.stage_label, "Converging (round 2)");
});

test("lineage_thread_view reproduces the migrated columns for every thread the poller wrote", () => {
  const db = viewDb();
  db.prepare("INSERT INTO plans (plan_key, title, issue_url) VALUES ('o/r#2', 'Epic', 'u-epic')").run();
  db.prepare("INSERT INTO feature_runs (feature_key, title, issue_url) VALUES ('o/r#1', 'Feat', 'u-feat')").run();
  const rows = [
    { root_request_key: "o/r#2", kind: "epic", title: "Epic", issue_url: "u-epic", stage: "converging", stage_label: "…", process_key: "a", pr_keys: "[]", pr_count: 2, active: 1 },
    { root_request_key: "o/r#1", kind: "feature", title: "Feat", issue_url: "u-feat", stage: "merged", stage_label: "Merged", process_key: "b", pr_keys: "[]", pr_count: 1, active: 0 },
    { root_request_key: "o/r#30", kind: "pr", title: "PR", issue_url: null, stage: "opened", stage_label: "Opened", process_key: null, pr_keys: "[]", pr_count: 1, active: 1 },
  ];
  for (const r of rows) addThread(db, r);

  // The view's migrated columns must equal what pollLineage denormalised, for all three kinds.
  for (const r of rows) {
    const v = db
      .prepare("SELECT kind, title, issue_url FROM lineage_thread_view WHERE root_request_key = ?")
      .get(r.root_request_key) as Record<string, unknown>;
    assertEquals(v.kind, r.kind);
    assertEquals(v.title, r.title);
    assertEquals(v.issue_url, r.issue_url);
  }
});
