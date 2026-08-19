// Regression guard for migration 043's epic_phase_label backfill (issue #304). The Convergence
// PR-row detail surfaces an epic slice's parent-epic phase via `pull_requests.epic_phase_label`. The
// column is maintained going forward by `pollLineage` (`projectEpicPhaseLabels`), but pre-existing
// rows must be backfilled at deploy time so the epic panel is populated before the first poll pass:
// an epic slice PR (its `root_request_key` is an epic `plans.plan_key`) takes that epic's
// `plans.epic_phase`; a feature/self-rooted PR (no matching plan) stays NULL — no empty epic panel.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertEquals } from "#test-assert";

function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  // Minimal pre-043 shape: pull_requests WITH root_request_key (037) but WITHOUT epic_phase_label
  // (043 ADD COLUMNs it), plus the plans table the backfill joins on for the epic phase.
  db.exec(`
    CREATE TABLE pull_requests (pr_key TEXT PRIMARY KEY, repo TEXT, number INTEGER, url TEXT,
      status TEXT, root_request_key TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE plans (plan_key TEXT PRIMARY KEY, epic_phase TEXT);
  `);
  const ins = (k: string, root: string) =>
    db
      .prepare(
        `INSERT INTO pull_requests (pr_key, repo, number, url, status, root_request_key, created_at, updated_at)
         VALUES (?, 'o/r', 1, 'u', 'converging', ?, 't', 't')`,
      )
      .run(k, root);
  ins("o/r#20", "o/r#2"); // epic slice of a phased epic
  ins("o/r#21", "o/r#3"); // epic slice of a grandfathered epic (epic_phase NULL)
  ins("o/r#30", "o/r#30"); // self-rooted (human/webhook) PR — root is its own key, no plan
  ins("o/r#40", "o/r#1"); // feature-rooted PR — root is a feature key, no matching plan
  db.prepare("INSERT INTO plans (plan_key, epic_phase) VALUES ('o/r#2', 'Implementing (wave 3/5)')").run();
  db.prepare("INSERT INTO plans (plan_key, epic_phase) VALUES ('o/r#3', NULL)").run();

  const sql = readFileSync(
    fileURLToPath(new URL("../db/migrations/043_pr_epic_phase.sql", import.meta.url)),
    "utf8",
  );
  db.exec(sql);
  return db;
}

test("migration 043 backfills epic slice PRs with their epic's phase and leaves non-epic PRs NULL", () => {
  const db = migratedDb();
  const labelOf = (k: string) =>
    (
      db.prepare("SELECT epic_phase_label AS l FROM pull_requests WHERE pr_key = ?").get(k) as {
        l: string | null;
      }
    ).l;

  // An epic slice roots on its epic's plan_key, so it inherits that epic's stamped phase.
  assertEquals(labelOf("o/r#20"), "Implementing (wave 3/5)");
  // A slice of a grandfathered epic (epic_phase NULL) stays NULL — the poller reconciles the
  // delivery-rollup fallback on its next pass; the migration only seeds the stamped phase.
  assertEquals(labelOf("o/r#21"), null);
  // A self-rooted PR has no matching plan → no epic panel.
  assertEquals(labelOf("o/r#30"), null);
  // A feature-rooted PR has no matching plan → no epic panel.
  assertEquals(labelOf("o/r#40"), null);
});
