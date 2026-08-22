// Coverage for the Epic-detail wave visualization + task→representation links (issue #411).
//
// Two guards, mirroring the repo's split between a derived-read-model test (migration042.test.ts —
// apply the migration to a real in-memory DB and assert its output) and a page-projection guard
// (waitGateVisibility.test.ts — pure text assertions that the declarative page wires the surface):
//
//   1. The VIEW rollup over sample `plan_tasks` × `pull_requests` rows: the six-way per-wave count
//      partition and the pre-formatted `bar` string. Because `plan_wave_summary` is a VIEW (the whole
//      point of #411 — a single derived source of truth, enabled by nano-ide#424) this exercises the
//      real SQLite view, not a re-implementation.
//   2. The epic-detail page projects the wave banner, the per-wave summary section, and the
//      task→representation links (PR url + processExplorer instance) on the wave-state grid.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "#test-assert";

const MIGRATION = fileURLToPath(new URL("../db/migrations/059_plan_wave_summary.sql", import.meta.url));
const PAGE = fileURLToPath(new URL("../pages/epic-detail.page.json", import.meta.url));

/** A DB with the base `plan_tasks` / `pull_requests` shapes the views read, plus the views applied. */
function viewDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE plan_tasks (
       id INTEGER PRIMARY KEY, plan_key TEXT, task_index INTEGER, task_id TEXT, title TEXT,
       prompt TEXT, status TEXT, pr_key TEXT, summary TEXT, created_at TEXT, updated_at TEXT,
       wave INTEGER, open_question TEXT, answer TEXT, draft_pr_key TEXT, corr_key TEXT);
     CREATE TABLE pull_requests (pr_key TEXT PRIMARY KEY, url TEXT, status TEXT, process_key TEXT);`,
  );
  db.exec(readFileSync(MIGRATION, "utf8"));
  return db;
}

function addTask(
  db: DatabaseSync,
  plan_key: string,
  task_index: number,
  status: string,
  wave: number,
  pr?: { pr_key: string; url: string; status: string; process_key: string },
): void {
  db.prepare(
    "INSERT INTO plan_tasks (plan_key, task_index, task_id, status, pr_key, wave) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(plan_key, task_index, `t${task_index}`, status, pr?.pr_key ?? null, wave);
  if (pr) {
    db.prepare(
      "INSERT INTO pull_requests (pr_key, url, status, process_key) VALUES (?, ?, ?, ?)",
    ).run(pr.pr_key, pr.url, pr.status, pr.process_key);
  }
}

test("plan_wave_summary partitions each wave's tasks and pre-formats the progress bar", () => {
  const db = viewDb();
  const plan = "o/r#1";
  // Wave 0 — 5 tasks: 3 merged, 1 converging (in-flight), 1 blocked (no PR).
  addTask(db, plan, 0, "opened", 0, { pr_key: "o/r#10", url: "https://gh/10", status: "merged", process_key: "P10" });
  addTask(db, plan, 1, "opened", 0, { pr_key: "o/r#11", url: "https://gh/11", status: "merged", process_key: "P11" });
  addTask(db, plan, 2, "opened", 0, { pr_key: "o/r#12", url: "https://gh/12", status: "merged", process_key: "P12" });
  addTask(db, plan, 3, "opened", 0, { pr_key: "o/r#13", url: "https://gh/13", status: "converging", process_key: "P13" });
  addTask(db, plan, 4, "blocked", 0);
  // Wave 1 — an escalated slice (with a draft PR) and a skipped slice.
  addTask(db, plan, 5, "escalated", 1, { pr_key: "o/r#14", url: "https://gh/14", status: "escalated", process_key: "P14" });
  addTask(db, plan, 6, "skipped", 1);

  const rows = db
    .prepare("SELECT * FROM plan_wave_summary WHERE plan_key = ? ORDER BY wave")
    .all(plan) as Array<Record<string, unknown>>;
  assertEquals(rows.length, 2);

  const w0 = rows[0];
  assertEquals(w0.total, 5);
  assertEquals(w0.merged, 3);
  assertEquals(w0.in_flight, 1);
  assertEquals(w0.blocked, 1);
  assertEquals(w0.escalated, 0);
  assertEquals(w0.skipped, 0);
  // 3 filled + 2 empty glyphs (width = total), then the named non-zero categories.
  assertEquals(w0.bar, "▓▓▓░░ 3/5 merged · 1 in-flight · 1 blocked");

  const w1 = rows[1];
  assertEquals(w1.total, 2);
  assertEquals(w1.merged, 0);
  assertEquals(w1.in_flight, 0);
  assertEquals(w1.escalated, 1);
  assertEquals(w1.skipped, 1);
  assertEquals(w1.bar, "░░ 0/2 merged · 1 escalated · 1 skipped");
});

test("a merged PR wins over the task's own status, and unlevelized tasks are excluded", () => {
  const db = viewDb();
  const plan = "o/r#2";
  // An escalated task whose PR nonetheless merged counts as merged, not escalated (PR wins).
  addTask(db, plan, 0, "escalated", 0, { pr_key: "o/r#20", url: "https://gh/20", status: "merged", process_key: "P20" });
  // A task with no wave yet (not levelized) must not appear in any wave row.
  db.prepare(
    "INSERT INTO plan_tasks (plan_key, task_index, task_id, status, wave) VALUES (?, ?, ?, ?, NULL)",
  ).run(plan, 1, "t1", "pending");

  const rows = db
    .prepare("SELECT wave, total, merged, escalated FROM plan_wave_summary WHERE plan_key = ?")
    .all(plan) as Array<Record<string, unknown>>;
  assertEquals(rows.length, 1);
  assertEquals(rows[0].wave, 0);
  assertEquals(rows[0].total, 1);
  assertEquals(rows[0].merged, 1);
  assertEquals(rows[0].escalated, 0);
});

test("plan_wave_tasks carries each task's PR url + process_key link targets", () => {
  const db = viewDb();
  addTask(db, "o/r#3", 0, "opened", 0, { pr_key: "o/r#30", url: "https://gh/30", status: "converging", process_key: "P30" });
  addTask(db, "o/r#3", 1, "blocked", 0); // no PR → null link targets

  const rows = db
    .prepare("SELECT task_id, pr_key, pr_url, process_key FROM plan_wave_tasks WHERE plan_key = ? ORDER BY task_index")
    .all("o/r#3") as Array<Record<string, unknown>>;
  assertEquals(rows[0].pr_url, "https://gh/30");
  assertEquals(rows[0].process_key, "P30");
  assertEquals(rows[1].pr_url, null);
  assertEquals(rows[1].process_key, null);
});

test("epic-detail projects the wave banner, the per-wave summary, and task→representation links", () => {
  const page = JSON.parse(readFileSync(PAGE, "utf8"));
  const byId = (id: string) => page.nodes.find((n: { id: string }) => n.id === id);

  // 1. The epic-level wave banner: a prose node reading wave_label + epic_phase off the derived
  //    `plan_read_model` VIEW (epic #412 — retiring the worker-maintained plans.wave_label column;
  //    the banner now reads the single-source-of-truth view instead of the raw `plans` table).
  const banner = byId("wave-banner");
  assert(banner, "epic detail must show the epic-level wave banner");
  assertEquals(banner.props.data.table, "plan_read_model");
  assert(
    banner.props.data.filter.some((f: { field: string; eqParam?: boolean }) => f.field === "plan_key" && f.eqParam),
    "the banner is scoped to this epic",
  );
  assert(/\{\{\s*wave_label\s*\}\}/.test(banner.props.header), "the banner surfaces the wave_label");
  assert(/\{\{\s*epic_phase\s*\}\}/.test(banner.props.header), "the banner surfaces the epic phase");

  // 2. The per-wave summary section: a grid over the derived VIEW, ordered by wave, with the bar.
  const summary = byId("wave-summary");
  assert(summary, "epic detail must show the per-wave progress summary");
  assertEquals(summary.props.data.table, "plan_wave_summary");
  assertEquals(summary.props.data.orderBy.field, "wave");
  const summaryCols: string[] = summary.props.columns.map((c: { field: string }) => c.field);
  for (const f of ["wave", "bar", "merged", "in_flight", "blocked", "escalated", "skipped", "total"]) {
    assert(summaryCols.includes(f), `the summary grid shows ${f}`);
  }

  // 3. The wave-state grid links each in-flight task to its representation (PR + process instance).
  const waveState = byId("wave-state");
  assert(waveState, "epic detail must keep the wave-state grid");
  assertEquals(waveState.props.data.table, "plan_wave_tasks");
  const cols: Array<Record<string, unknown>> = waveState.props.columns;
  const prCol = cols.find((c) => c.field === "pr_key");
  assertEquals(prCol?.linkField, "pr_url", "the PR cell links to the GitHub PR url");
  const statusCol = cols.find((c) => c.field === "status") as {
    link?: { kind?: string; keyField?: string };
  };
  assertEquals(statusCol.link?.kind, "processExplorer", "the status cell links to the process instance");
  assertEquals(statusCol.link?.keyField, "process_key");
  // The existing tabs (Active / Skipped / All) and detail drawer must still be present.
  assertEquals(waveState.props.tabs.length, 3);
  const detailFields: string[] = waveState.props.detail.fields.map((f: { field: string }) => f.field);
  for (const f of ["open_question", "answer", "draft_pr_key", "prompt"]) {
    assert(detailFields.includes(f), `the detail drawer keeps ${f}`);
  }
});
