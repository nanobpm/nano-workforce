// Read-model VIEW coverage for the plans-table wave (022) and delivery (029) projections (epic #412
// — "Retire worker-maintained denormalized projections in favour of SQL VIEWs").
//
// Historically `plans.wave_count`/`current_wave`/`wave_label` (022_plan_wave_progress.sql) were
// written by the wave workers, and `plans.delivery`/`delivery_label` (029_plan_delivery.sql) by
// `pollDelivery` (app/service.ts) via the pure `deriveDelivery` (app/delivery.ts) — both denormalised
// onto `plans` only because "Urban's datasource cannot read a SQL VIEW". That constraint is gone
// (nano-ide#424), so 060/061 express the SAME projections as DERIVED views. This asserts the views
// reproduce the previous projections' EXACT values — including the pre-formatted `wave_label` /
// `delivery_label` display strings — over sample `plans` × `plan_tasks` × `pull_requests` rows, so
// the wave-1 cleanup can drop the worker write-paths + columns with no behavioural change.
//
// The delivery assertions cross-check against the real `deriveDelivery` (the single source of truth
// the poller used), not a re-implementation; the wave assertions pin the frontier derivation that
// reproduces the workers' `current_wave` (record-plan starts at 0, advances per landed wave, pins to
// wave_count-1 on completion).
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "#test-assert";
import { deriveDelivery } from "./delivery.ts";

const MIG = (name: string) => readFileSync(fileURLToPath(new URL(`../db/migrations/${name}`, import.meta.url)), "utf8");
const PAGE = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../pages/${name}`, import.meta.url)), "utf8"));

// A DB with the base `plans` / `plan_tasks` / `pull_requests` shapes the views read (the `plans`
// columns `plan_read_model` projects, and the full `plan_tasks` shape 059's `plan_wave_tasks`
// reads), plus 059→061 applied in order.
function viewDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE plans (
       plan_key TEXT PRIMARY KEY, repo TEXT, issue_number INTEGER, issue_url TEXT, title TEXT,
       status TEXT, task_count INTEGER, process_key TEXT, outcome TEXT, created_at TEXT,
       updated_at TEXT, epic_phase TEXT, base_branch TEXT, wait_gate_label TEXT, bound_artifacts TEXT,
       promotion_pr TEXT, promotion_state TEXT, list_bucket TEXT, ack_open INTEGER);
     CREATE TABLE plan_tasks (
       id INTEGER PRIMARY KEY, plan_key TEXT, task_index INTEGER, task_id TEXT, title TEXT,
       prompt TEXT, status TEXT, pr_key TEXT, summary TEXT, created_at TEXT, updated_at TEXT,
       wave INTEGER, open_question TEXT, answer TEXT, draft_pr_key TEXT, corr_key TEXT);
     CREATE TABLE pull_requests (pr_key TEXT PRIMARY KEY, url TEXT, status TEXT, process_key TEXT);`,
  );
  db.exec(MIG("059_plan_wave_summary.sql"));
  db.exec(MIG("060_plan_wave_rollup.sql"));
  db.exec(MIG("061_plan_delivery_rollup.sql"));
  return db;
}

interface SampleTask {
  status: string;
  wave: number | null;
  pr?: { status: string };
}

// Insert a plan plus its tasks (and each task's PR, if any). PR keys are derived so the test rows
// stay terse. Returns the flat `pull_requests.status` list `deriveDelivery` consumes (only tasks
// that opened a PR), so the delivery assertions can cross-check the view against it.
function addPlan(db: DatabaseSync, plan_key: string, status: string, tasks: SampleTask[]): string[] {
  db.prepare(
    "INSERT INTO plans (plan_key, repo, issue_number, issue_url, status, task_count, updated_at, list_bucket) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(plan_key, "o/r", 1, `https://gh/${plan_key}`, status, tasks.length, "2026-01-01T00:00:00Z", "active");
  const prStatuses: string[] = [];
  tasks.forEach((t, i) => {
    const prKey = t.pr ? `${plan_key}::pr${i}` : null;
    db.prepare(
      "INSERT INTO plan_tasks (plan_key, task_index, task_id, status, pr_key, wave) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(plan_key, i, `t${i}`, t.status, prKey, t.wave);
    if (t.pr && prKey) {
      db.prepare("INSERT INTO pull_requests (pr_key, url, status, process_key) VALUES (?, ?, ?, ?)").run(
        prKey,
        `https://gh/${prKey}`,
        t.pr.status,
        `P${i}`,
      );
      prStatuses.push(t.pr.status);
    }
  });
  return prStatuses;
}

function delivery(db: DatabaseSync, plan_key: string): { delivery: unknown; delivery_label: unknown } {
  return db.prepare("SELECT delivery, delivery_label FROM plan_delivery WHERE plan_key = ?").get(plan_key) as {
    delivery: unknown;
    delivery_label: unknown;
  };
}

function waveLabel(db: DatabaseSync, plan_key: string): Record<string, unknown> | undefined {
  const r = db.prepare("SELECT wave_count, current_wave, wave_label FROM plan_wave_label WHERE plan_key = ?").get(plan_key) as
    | Record<string, unknown>
    | undefined;
  return r === undefined ? undefined : { ...r };
}

test("plan_delivery reproduces deriveDelivery exactly (converging / landed / not-done / resolved-not-landed / taskless)", () => {
  const db = viewDb();
  // A `done` epic with slices still in flight → converging.
  const a = addPlan(db, "o/r#1", "done", [
    { status: "opened", wave: 0, pr: { status: "merged" } },
    { status: "opened", wave: 0, pr: { status: "merged" } },
    { status: "opened", wave: 1, pr: { status: "converging" } },
    { status: "blocked", wave: 1 },
  ]);
  // A `done` epic with every slice PR merged → landed.
  const b = addPlan(db, "o/r#2", "done", [
    { status: "opened", wave: 0, pr: { status: "merged" } },
    { status: "opened", wave: 0, pr: { status: "merged" } },
  ]);
  // A `dispatched` (not-done) epic → no positive delivery signal yet, even with an open PR.
  const c = addPlan(db, "o/r#3", "dispatched", [
    { status: "opened", wave: 0, pr: { status: "converging" } },
    { status: "pending", wave: 1 },
    { status: "pending", wave: 2 },
  ]);
  // A `done` epic where every PR is terminal but not all merged (one abandoned) → resolved, NOT landed.
  const d = addPlan(db, "o/r#4", "done", [
    { status: "opened", wave: 0, pr: { status: "merged" } },
    { status: "opened", wave: 0, pr: { status: "abandoned" } },
  ]);
  // A `planning` epic with no tasks → no PRs → null.
  const e = addPlan(db, "o/r#5", "planning", []);

  for (const [plan_key, status, prStatuses] of [
    ["o/r#1", "done", a],
    ["o/r#2", "done", b],
    ["o/r#3", "dispatched", c],
    ["o/r#4", "done", d],
    ["o/r#5", "planning", e],
  ] as const) {
    const expected = deriveDelivery(status, prStatuses);
    const row = delivery(db, plan_key);
    assertEquals(row.delivery, expected.delivery, `${plan_key}: delivery`);
    assertEquals(row.delivery_label, expected.label, `${plan_key}: delivery_label`);
  }

  // Pin the exact pre-formatted strings so a formatting drift can't hide behind the cross-check.
  assertEquals(delivery(db, "o/r#1").delivery_label, "2/3 slices merged, 1 converging");
  assertEquals(delivery(db, "o/r#2").delivery_label, "2/2 slices merged");
  assertEquals(delivery(db, "o/r#4").delivery, null);
});

test("plan_wave_label reproduces the workers' wave_count / current_wave / wave_label projection", () => {
  const db = viewDb();
  // Wave 0 fully merged, wave 1 still converging → frontier is wave 1 (the gating wave). "2/2".
  addPlan(db, "o/r#1", "done", [
    { status: "opened", wave: 0, pr: { status: "merged" } },
    { status: "opened", wave: 0, pr: { status: "merged" } },
    { status: "opened", wave: 1, pr: { status: "converging" } },
    { status: "blocked", wave: 1 },
  ]);
  // Single wave, all merged → frontier pins to the last index (0). "1/1".
  addPlan(db, "o/r#2", "done", [
    { status: "opened", wave: 0, pr: { status: "merged" } },
    { status: "opened", wave: 0, pr: { status: "merged" } },
  ]);
  // Three waves, freshly dispatched (all in flight) → frontier is wave 0. "1/3".
  addPlan(db, "o/r#3", "dispatched", [
    { status: "opened", wave: 0, pr: { status: "converging" } },
    { status: "pending", wave: 1 },
    { status: "pending", wave: 2 },
  ]);
  // No levelized tasks → no wave rollup row (matches the workers leaving a taskless plan NULL).
  addPlan(db, "o/r#5", "planning", []);

  assertEquals(waveLabel(db, "o/r#1"), { wave_count: 2, current_wave: 1, wave_label: "2/2" });
  assertEquals(waveLabel(db, "o/r#2"), { wave_count: 1, current_wave: 0, wave_label: "1/1" });
  assertEquals(waveLabel(db, "o/r#3"), { wave_count: 3, current_wave: 0, wave_label: "1/3" });
  assertEquals(waveLabel(db, "o/r#5"), undefined);
});

test("plan_read_model joins the derived wave + delivery projections onto the plans row", () => {
  const db = viewDb();
  addPlan(db, "o/r#1", "done", [
    { status: "opened", wave: 0, pr: { status: "merged" } },
    { status: "opened", wave: 1, pr: { status: "converging" } },
  ]);
  addPlan(db, "o/r#5", "planning", []);

  const row = db.prepare("SELECT * FROM plan_read_model WHERE plan_key = ?").get("o/r#1") as Record<string, unknown>;
  assertEquals(row.plan_key, "o/r#1");
  assertEquals(row.status, "done");
  assertEquals(row.list_bucket, "active");
  assertEquals(row.wave_label, "2/2");
  assertEquals(row.wave_count, 2);
  assertEquals(row.current_wave, 1);
  assertEquals(row.delivery, "converging");
  assertEquals(row.delivery_label, "1/2 slices merged, 1 converging");

  // A taskless plan still appears (LEFT JOINs), with the derived columns NULL.
  const empty = db.prepare("SELECT wave_label, delivery, delivery_label FROM plan_read_model WHERE plan_key = ?").get("o/r#5") as Record<string, unknown>;
  assertEquals({ ...empty }, { wave_label: null, delivery: null, delivery_label: null });
});

test("the operator pages read the derived plan_read_model VIEW for the wave/delivery cells", () => {
  // Overview epics grid — binds the view and still surfaces wave_label + delivery_label.
  const overview = PAGE("overview.page.json");
  const epics = (overview.nodes ?? []).find((n: { id: string }) => n.id === "overview-epics");
  assert(epics, "overview must keep the Active Epics grid");
  assertEquals(epics.props.data.table, "plan_read_model");
  const epicCols: string[] = epics.props.columns.map((c: { field: string }) => c.field);
  assert(epicCols.includes("wave_label") && epicCols.includes("delivery_label"), "overview epics grid surfaces wave_label + delivery_label");

  // Epic-detail wave banner + plan grid both read the view.
  const detail = PAGE("epic-detail.page.json");
  const byId = (id: string) => (detail.nodes ?? []).find((n: { id: string }) => n.id === id);
  assertEquals(byId("wave-banner").props.data.table, "plan_read_model");
  assertEquals(byId("epic-plan").props.data.table, "plan_read_model");
  assert(/\{\{\s*wave_label\s*\}\}/.test(byId("wave-banner").props.header), "the banner surfaces wave_label");
  assertEquals(byId("wave-banner").props.body, "delivery_label", "the banner body is the delivery_label");
});
