// Regression guard for migration 037's root_request_key backfill (PR #253, issue #245). The Lineage
// page drills a thread's PRs via `lineage_threads.root_request_key → pull_requests.root_request_key`,
// where the thread key is the origin (feature_key / plan_key), or a self-rooted pr_key. A legacy PR
// predates the column (NULL), so the backfill must reconstruct the SAME root `submitPr` persists going
// forward — the feature/epic ORIGIN key for a tracked PR, self-rooted pr_key only for an origin-less
// one. Self-rooting a tracked PR would orphan it from its feature/epic thread (empty drill-down list).
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertEquals } from "#test-assert";

function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  // Minimal pre-037 shape: pull_requests WITHOUT root_request_key (037 ADD COLUMNs it), plus the two
  // origin tables the backfill joins.
  db.exec(`
    CREATE TABLE pull_requests (pr_key TEXT PRIMARY KEY, repo TEXT, number INTEGER, url TEXT,
      status TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE feature_runs (feature_key TEXT PRIMARY KEY, pr_key TEXT);
    CREATE TABLE plans (plan_key TEXT PRIMARY KEY);
    CREATE TABLE plan_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_key TEXT, pr_key TEXT);
  `);
  const ins = (k: string) =>
    db
      .prepare(
        `INSERT INTO pull_requests (pr_key, repo, number, url, status, created_at, updated_at)
         VALUES (?, 'o/r', 1, 'u', 'converging', 't', 't')`,
      )
      .run(k);
  ins("o/r#10"); // spawned by a feature run
  ins("o/r#20"); // spawned by an epic slice
  ins("o/r#30"); // origin-less (human/webhook)
  db.prepare("INSERT INTO feature_runs (feature_key, pr_key) VALUES ('o/r#1', 'o/r#10')").run();
  db.prepare("INSERT INTO plans (plan_key) VALUES ('o/r#2')").run();
  db.prepare("INSERT INTO plan_tasks (plan_key, pr_key) VALUES ('o/r#2', 'o/r#20')").run();

  const sql = readFileSync(
    fileURLToPath(new URL("../db/migrations/037_lineage.sql", import.meta.url)),
    "utf8",
  );
  db.exec(sql);
  return db;
}

test("migration 037 backfill roots each legacy PR on its true origin, self-rooting only origin-less rows", () => {
  const db = migratedDb();
  const rootOf = (k: string) =>
    (
      db.prepare("SELECT root_request_key AS r FROM pull_requests WHERE pr_key = ?").get(k) as {
        r: string;
      }
    ).r;

  // A feature-spawned PR roots on its feature_runs origin, NOT its own pr_key — otherwise the
  // drill-down join against the feature thread (keyed feature_key) yields an empty PR list.
  assertEquals(rootOf("o/r#10"), "o/r#1");
  // An epic-slice PR roots on its plan_tasks origin.
  assertEquals(rootOf("o/r#20"), "o/r#2");
  // An origin-less PR self-roots on its own pr_key.
  assertEquals(rootOf("o/r#30"), "o/r#30");
});
