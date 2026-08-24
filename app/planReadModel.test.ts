// Read-model coverage for the plan-family (Epic) projections — the wave rollups, the slice-PR
// delivery counts, and the per-row delivery/bucket/ack signals — now authored via Urban's ADR-0065
// declare-once primitives (`defineRollup`, app/planRollups.ts; `defineReadModel` + key-correlated
// rollup lookups, app/planReadModel.ts). Issue #493, the plan-family twin of app/featureReadModel.test.ts.
//
// 059/060/061 hand-authored the three GROUP-BY aggregates as SQL VIEWs AND a second time in the runtime
// TS; 074/080 hand-authored the per-row `delivery`/`list_bucket`/`ack_open` signals as SQL CASEs AND a
// TS oracle (`deriveDelivery`/`deriveEpicBucket`/`epicIsAcknowledgeable`, app/delivery.ts) — kept in
// lockstep by bespoke parity tests (app/plansReadModel.test.ts, app/planWaveSummary.test.ts,
// app/delivery.test.ts, the ADR-0065 drift surface #2). Migrations 082/083 supersede them: every
// rollup VIEW is emitted from its ONE `defineRollup`, and every derived read-model column from the ONE
// `defineReadModel` — both of which ALSO drive the runtime TS (`reduce`/`fnFor`, behind app/delivery.ts).
// This suite retires those hand-written parity tests in favour of the framework parity guard, and
// guards FOUR things:
//
//   1. DRIFT GUARD — migration 082 embeds each rollup's VIEW DDL VERBATIM from `rollup.viewDdl()`, and
//      migration 083 embeds each derived column VERBATIM from `planReadModel.sqlSelectFor(...)`, so the
//      checked-in VIEWs cannot drift from the declarations.
//   2. FRAMEWORK PARITY GUARD — `assertRollupParity` / `assertReadModelParity` prove the SQL and TS
//      lowerings each declaration compiles to agree (the role the retired hand-written tests played).
//   3. END-TO-END BEHAVIOUR on the REAL migration VIEWs (059→083 applied to an in-memory DB): the full
//      status × slice-PR × acknowledgement matrix vs the app/delivery.ts adapters, the hand-authored
//      display strings (`delivery_label`/`wave_label`, and 059's `bar` glyph), and the reconciler
//      `derived_status`-bypass.
//   4. PAGE BINDINGS — the operator pages bind the derived VIEWs (`plan_read_model`, `plan_wave_summary`,
//      `plan_wave_tasks`), never the raw `plans` table.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertReadModelParity, assertRollupParity, type ParityDb, type ParitySample, type RollupInputs } from "@nanobpm/urban";
import { assert, assertEquals } from "#test-assert";
import { deriveDelivery, deriveEpicBucket, epicIsAcknowledgeable } from "./delivery.ts";
import { planReadModel, PLAN_READ_MODEL_BASE_ALIAS, PLAN_READ_MODEL_DERIVED } from "./planReadModel.ts";
import { PLAN_ROLLUPS, planDeliveryCounts, planWaveCounts, planWaveProgress } from "./planRollups.ts";

const MIG = (name: string) => readFileSync(fileURLToPath(new URL(`../db/migrations/${name}`, import.meta.url)), "utf8");
const PAGE = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../pages/${name}`, import.meta.url)), "utf8"));

const ROLLUPS_MIGRATION = "082_plan_rollups_declare_once.sql";
const READ_MODEL_MIGRATION = "083_plan_read_model_declare_once.sql";
// The forward chain whose net effect the end-to-end tests exercise: the original hand-authored VIEWs
// (059/060/061/074/080) then the declare-once supersessions (082/083). Mirrors the runtime migrator.
const MIGRATION_CHAIN = [
  "059_plan_wave_summary.sql",
  "060_plan_wave_rollup.sql",
  "061_plan_delivery_rollup.sql",
  "074_plan_read_model_derive_bucket.sql",
  "080_plan_read_model_derive_terminal.sql",
  ROLLUPS_MIGRATION,
  READ_MODEL_MIGRATION,
];

// The base `plans` / `plan_tasks` / `pull_requests` shapes the VIEWs read, plus a stand-in for the
// managed `plans__tracking` derived VIEW (ADR-0065) the read model reads its terminal-folded
// `derived_status` off. `derived_status_override` lets a test model the reconciler's derive edge (a
// terminated instance ⇒ `abandoned` while base `status` stays frozen). The vestigial stored
// `list_bucket`/`ack_open` columns (#439) are present so a test can seed STALE values and prove the
// VIEW ignores them.
function viewDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE plans (
       plan_key TEXT PRIMARY KEY, repo TEXT, issue_number INTEGER, issue_url TEXT, title TEXT,
       status TEXT, task_count INTEGER, process_key TEXT, outcome TEXT, created_at TEXT, updated_at TEXT,
       epic_phase TEXT, base_branch TEXT, wait_gate_label TEXT, bound_artifacts TEXT, promotion_pr TEXT,
       promotion_state TEXT, acknowledged_at TEXT, list_bucket TEXT, ack_open INTEGER,
       derived_status_override TEXT);
     CREATE TABLE plan_tasks (
       id INTEGER PRIMARY KEY, plan_key TEXT, task_index INTEGER, task_id TEXT, title TEXT, prompt TEXT,
       status TEXT, pr_key TEXT, summary TEXT, created_at TEXT, updated_at TEXT, wave INTEGER,
       open_question TEXT, answer TEXT, draft_pr_key TEXT, corr_key TEXT);
     CREATE TABLE pull_requests (pr_key TEXT PRIMARY KEY, url TEXT, status TEXT, process_key TEXT);`,
  );
  // Stand-in for the managed `plans__tracking` VIEW urban provisions at mount: re-exports `plans.*`
  // plus the terminal-folded `derived_status`. A test seeds `derived_status_override` to model the
  // reconciler's derive edge; absent, it falls through to the base `status`.
  db.exec(
    `CREATE VIEW plans__tracking AS
       SELECT p.*, COALESCE(p.derived_status_override, p.status) AS derived_status FROM plans p;`,
  );
  for (const m of MIGRATION_CHAIN) db.exec(MIG(m));
  return db;
}

interface SamplePlan {
  status: string;
  acknowledged_at?: string | null;
  derived_status_override?: string | null;
  /** Deliberately-stale STORED projection columns (a row the gateway last projected in another status).
   *  The VIEW must ignore these and re-derive. */
  stored?: Partial<Record<"list_bucket" | "ack_open", string | number>>;
}

let taskId = 0;
function addPlan(db: DatabaseSync, plan_key: string, plan: SamplePlan): void {
  const s = plan.stored ?? {};
  db.prepare(
    `INSERT INTO plans (plan_key, repo, issue_number, issue_url, title, status, acknowledged_at,
        derived_status_override, list_bucket, ack_open, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    plan_key,
    "o/r",
    1,
    `https://gh/${plan_key}`,
    `Epic ${plan_key}`,
    plan.status,
    plan.acknowledged_at ?? null,
    plan.derived_status_override ?? null,
    s.list_bucket ?? null,
    s.ack_open ?? null,
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
  );
}

/** Add one slice task, optionally with a PR. `prStatus === undefined` ⇒ no PR row (an un-opened slice);
 *  `prStatus === "missing"` ⇒ a `pr_key` with NO `pull_requests` row (the poller's dangling-PR sentinel). */
function addTask(db: DatabaseSync, plan_key: string, opts: { status?: string; wave?: number | null; prStatus?: string }): void {
  const id = taskId++;
  const prKey = opts.prStatus === undefined ? null : `pr${id}`;
  db.prepare(
    "INSERT INTO plan_tasks (id, plan_key, task_index, task_id, status, pr_key, wave) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, plan_key, id, `t${id}`, opts.status ?? "opened", prKey, opts.wave ?? null);
  if (prKey !== null && opts.prStatus !== "missing") {
    db.prepare("INSERT INTO pull_requests (pr_key, url, status, process_key) VALUES (?, ?, ?, ?)").run(
      prKey,
      `https://gh/${prKey}`,
      opts.prStatus,
      `P${id}`,
    );
  }
}

function readModel(db: DatabaseSync, plan_key: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM plan_read_model WHERE plan_key = ?").get(plan_key) as Record<string, unknown>;
}

// A `ParityDb` over node:sqlite's `DatabaseSync` for the framework parity guards (which need positional
// `exec`/`all`/`run`, whereas `DatabaseSync` exposes query methods on prepared statements).
function parityDb(db: DatabaseSync): ParityDb {
  return {
    exec: (sql) => db.exec(sql),
    all: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])) as T[],
    run: (sql, params: unknown[] = []) => {
      const r = db.prepare(sql).run(...(params as never[]));
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    },
  };
}

test("DRIFT GUARD: migration 082 embeds each rollup's VIEW DDL VERBATIM from rollup.viewDdl() (the VIEWs cannot drift from defineRollup)", () => {
  const sql = MIG(ROLLUPS_MIGRATION);
  for (const rollup of PLAN_ROLLUPS) {
    assert(
      sql.includes(rollup.viewDdl()),
      `migration ${ROLLUPS_MIGRATION} no longer embeds the declaration's VIEW DDL for rollup "${rollup.decl.name}" — ` +
        `regenerate it from app/planRollups.ts (or add a new superseding migration). Expected to contain:\n${rollup.viewDdl()}`,
    );
    // Each superseded VIEW is DROP+CREATEd (059/060/061 are immutable — this supersedes their bodies).
    assert(new RegExp(`DROP VIEW IF EXISTS ${rollup.decl.name};`).test(sql), `082 must DROP the superseded "${rollup.decl.name}" first`);
  }
});

test("DRIFT GUARD: migration 083 embeds each derived column VERBATIM from planReadModel.sqlSelectFor (the VIEW cannot drift from the declaration)", () => {
  const sql = MIG(READ_MODEL_MIGRATION);
  for (const col of PLAN_READ_MODEL_DERIVED) {
    const emitted = planReadModel.sqlSelectFor(col, { baseAlias: PLAN_READ_MODEL_BASE_ALIAS });
    assert(
      sql.includes(`${emitted} AS ${col}`),
      `migration ${READ_MODEL_MIGRATION} no longer embeds the declaration's SQL for "${col}" — regenerate it ` +
        `from app/planReadModel.ts (or add a new superseding migration). Expected to contain:\n  ${emitted} AS ${col}`,
    );
  }
  // DROP+CREATE that supersedes 080 and folds in (drops) the now-redundant intermediate VIEWs, keeping
  // every base column an aliased pass-through so the static pages↔schema contract guard still sees them.
  assert(/DROP VIEW IF EXISTS plan_read_model;/.test(sql), "083 must DROP the superseded plan_read_model first");
  assert(/DROP VIEW IF EXISTS plan_delivery;/.test(sql), "083 must fold in (drop) the retired plan_delivery");
  assert(/DROP VIEW IF EXISTS plan_wave_label;/.test(sql), "083 must fold in (drop) the retired plan_wave_label");
  assert(/CREATE VIEW plan_read_model AS/.test(sql), "083 must (re)create plan_read_model");
  for (const base of ["plan_key", "repo", "issue_number", "title", "process_key", "epic_phase", "promotion_pr", "promotion_state"]) {
    assert(sql.includes(`pl.${base} AS ${base}`), `083 must pass base column "${base}" through the VIEW`);
  }
  // The hand-authored display strings (D3 — no TS twin) live in this VIEW over the derived columns.
  assert(sql.includes("AS delivery_label"), "083 must carry the hand-authored delivery_label display column");
  assert(sql.includes("AS wave_label"), "083 must carry the hand-authored wave_label display column");
});

test("FRAMEWORK PARITY GUARD: each plan-family rollup's VIEW and TS reduce agree (assertRollupParity)", () => {
  // Sample leaf rows spanning: multi-wave plans, every task/PR status, dangling pr_key (no PR row),
  // un-levelized (NULL wave) tasks, and taskless plans — the predicates the rollups turn on.
  const sampleSets: RollupInputs[] = [
    {
      plan_tasks: [
        { plan_key: "a", pr_key: "a0", wave: 0, status: "opened" },
        { plan_key: "a", pr_key: "a1", wave: 0, status: "opened" },
        { plan_key: "a", pr_key: "a2", wave: 1, status: "escalated" },
        { plan_key: "a", pr_key: null, wave: 1, status: "blocked" },
        { plan_key: "a", pr_key: "a3", wave: null, status: "pending" },
        { plan_key: "b", pr_key: "b0", wave: 0, status: "skipped" },
        { plan_key: "b", pr_key: "bMissing", wave: 0, status: "opened" },
      ],
      pull_requests: [
        { pr_key: "a0", status: "merged" },
        { pr_key: "a1", status: "converging" },
        { pr_key: "a2", status: "merged" },
        { pr_key: "a3", status: "waiting_review" },
        { pr_key: "b0", status: "abandoned" },
      ],
    },
    { plan_tasks: [], pull_requests: [] },
    {
      plan_tasks: [
        { plan_key: "c", pr_key: "c0", wave: 0, status: "opened" },
        { plan_key: "c", pr_key: "c1", wave: 2, status: "opened" },
      ],
      pull_requests: [
        { pr_key: "c0", status: "merged" },
        { pr_key: "c1", status: "converged" },
      ],
    },
  ];
  for (const rollup of PLAN_ROLLUPS) {
    const db = new DatabaseSync(":memory:");
    assertRollupParity(rollup, parityDb(db), sampleSets);
    db.close();
  }
});

test("FRAMEWORK PARITY GUARD: planReadModel's SQL and TS lowerings agree over the status × counts × ack matrix (assertReadModelParity)", () => {
  const samples: ParitySample[] = [];
  for (const status of ["planning", "dispatched", "done", "failed", "abandoned"]) {
    for (const derived_status of [status, "abandoned"]) {
      for (const acknowledged_at of [null, "2026-02-02T00:00:00Z"]) {
        for (const dc of [
          { prs_opened: 0, prs_merged: 0, prs_in_flight: 0 },
          { prs_opened: 3, prs_merged: 1, prs_in_flight: 2 },
          { prs_opened: 3, prs_merged: 3, prs_in_flight: 0 },
          { prs_opened: 2, prs_merged: 1, prs_in_flight: 0 },
        ]) {
          for (const wp of [[], [{ plan_key: "self", wave_count: 5, current_wave: 2 }]]) {
            samples.push({
              baseRow: { plan_key: "self", status, derived_status, acknowledged_at },
              lookups: { dc: [{ plan_key: "self", ...dc }], wp },
            });
          }
        }
      }
    }
  }
  const db = new DatabaseSync(":memory:");
  assertReadModelParity(planReadModel, parityDb(db), samples, { sql: { baseAlias: PLAN_READ_MODEL_BASE_ALIAS } });
  db.close();
});

test("the migration 083 VIEW derives delivery / list_bucket / ack_open EXACTLY like the app/delivery.ts adapters, over the status × slice-PR × ack matrix", () => {
  const db = viewDb();
  const inFlightPr = "waiting_review";
  // Slice-PR shapes exercising every delivery arm: none, all merged (landed), one in-flight
  // (converging), all terminal-not-merged (resolved-null), and a dangling pr_key (in-flight).
  const prSets: Record<string, string[]> = {
    none: [],
    landed: ["merged", "merged"],
    converging: ["merged", inFlightPr],
    resolved: ["merged", "abandoned"],
    convergedOnly: ["merged", "converged"],
    dangling: ["merged", "missing"],
  };
  const cases: Array<{ key: string; status: string; ackAt: string | null; override: string | null; prStatuses: string[] }> = [];
  let i = 0;
  for (const status of ["planning", "dispatched", "done", "failed", "abandoned"]) {
    for (const [shape, prStatuses] of Object.entries(prSets)) {
      for (const ackAt of [null, "2026-02-02T00:00:00Z"]) {
        for (const override of [null, "abandoned"]) {
          const key = `o/r#${i++}`;
          cases.push({ key, status, ackAt, override, prStatuses });
          addPlan(db, key, { status, acknowledged_at: ackAt, derived_status_override: override });
          prStatuses.forEach((ps, w) => addTask(db, key, { status: "opened", wave: w, prStatus: ps }));
          void shape;
        }
      }
    }
  }
  for (const { key, status, ackAt, override, prStatuses } of cases) {
    const row = readModel(db, key);
    const effectiveStatus = override ?? status;
    // `delivery` reads the BASE status (`done` is terminal, so base/effective agree on the gate).
    const expected = deriveDelivery(status, prStatuses);
    assertEquals(row.delivery, expected.delivery, `${key} (status=${status}): delivery`);
    assertEquals(row.delivery_label, expected.label, `${key} (status=${status}): delivery_label`);
    // `list_bucket`/`ack_open` classify on the terminal-folded effective status.
    assertEquals(row.list_bucket, deriveEpicBucket(effectiveStatus, expected.delivery, ackAt), `${key} (status=${effectiveStatus}): list_bucket`);
    const expectedAck = epicIsAcknowledgeable(effectiveStatus, expected.delivery) && ackAt === null ? 1 : 0;
    assertEquals(row.ack_open, expectedAck, `${key} (status=${effectiveStatus}): ack_open`);
  }
});

test("the migration 083 VIEW projects the wave frontier + 1-based wave_label from plan_wave_progress (taskless plan ⇒ all NULL)", () => {
  const db = viewDb();
  // 3 waves; wave 0 fully merged, wave 1 in-flight (the frontier), wave 2 pending ⇒ current_wave = 1.
  addPlan(db, "o/r#w", { status: "done" });
  addTask(db, "o/r#w", { status: "opened", wave: 0, prStatus: "merged" });
  addTask(db, "o/r#w", { status: "opened", wave: 1, prStatus: "waiting_review" });
  addTask(db, "o/r#w", { status: "opened", wave: 2, prStatus: "waiting_review" });
  const w = readModel(db, "o/r#w");
  assertEquals(w.wave_count, 3);
  assertEquals(w.current_wave, 1);
  assertEquals(w.wave_label, "2/3");

  // A settled plan (every wave merged) pins current_wave to the last index ⇒ "N/N".
  addPlan(db, "o/r#done", { status: "done" });
  addTask(db, "o/r#done", { status: "opened", wave: 0, prStatus: "merged" });
  addTask(db, "o/r#done", { status: "opened", wave: 1, prStatus: "merged" });
  assertEquals(readModel(db, "o/r#done").wave_label, "2/2");

  // A taskless plan has no rollup row ⇒ the LEFT JOIN reads NULL through every wave/delivery column.
  addPlan(db, "o/r#empty", { status: "done" });
  const empty = readModel(db, "o/r#empty");
  assertEquals({ wave_label: empty.wave_label, wave_count: empty.wave_count, delivery: empty.delivery }, { wave_label: null, wave_count: null, delivery: null });
});

test("the migration 083 VIEW IGNORES stale STORED list_bucket / ack_open columns — it reads only the derived signals", () => {
  const db = viewDb();
  // A settled+acknowledged epic whose STORED bucket lies (frozen while it was live). The VIEW re-derives.
  addPlan(db, "o/r#stale", { status: "done", acknowledged_at: "2026-02-02T00:00:00Z", stored: { list_bucket: "active", ack_open: 1 } });
  addTask(db, "o/r#stale", { status: "opened", wave: 0, prStatus: "merged" });
  const row = readModel(db, "o/r#stale");
  assertEquals(row.list_bucket, "history", "an acknowledged landed epic is History regardless of the stale stored value");
  assertEquals(row.ack_open, 0, "already acknowledged ⇒ no open Dismiss");
});

test("RED/GREEN #503: a DERIVE-ONLY terminated epic (base status frozen 'dispatched', derived_status='abandoned') drops out of Active with no worker write", () => {
  // ADR-0065: cancel/terminate is DERIVE-ONLY — `plans__tracking.derived_status` recomputes `abandoned`
  // on READ while the base `plans.status` stays frozen at its last transient. 083 classifies the bucket
  // off `derived_status`, so a terminated epic renders History (not wedged Active) with no poller pass.
  const db = viewDb();
  addPlan(db, "o/r#term", { status: "dispatched", stored: { list_bucket: "active" } });
  assertEquals(readModel(db, "o/r#term").list_bucket, "active", "precondition: a live dispatched epic is Active");

  db.prepare("UPDATE plans SET derived_status_override = 'abandoned' WHERE plan_key = ?").run("o/r#term");
  const row = readModel(db, "o/r#term");
  assertEquals(row.list_bucket, "history", "a derive-only terminated epic is History (the #503 phantom fix)");
  assertEquals(row.list_bucket, deriveEpicBucket("abandoned", row.delivery === "converging" ? "converging" : null, null), "list_bucket tracks derived_status via the VIEW");
});

test("the migration 082 plan_wave_summary VIEW still pre-formats the `bar` glyph over the (now framework-emitted) plan_wave_counts", () => {
  const db = viewDb();
  const plan = "o/r#bar";
  addPlan(db, plan, { status: "done" });
  // Wave 0 — 5 tasks: 3 merged, 1 converging (in-flight), 1 blocked (no PR).
  addTask(db, plan, { status: "opened", wave: 0, prStatus: "merged" });
  addTask(db, plan, { status: "opened", wave: 0, prStatus: "merged" });
  addTask(db, plan, { status: "opened", wave: 0, prStatus: "merged" });
  addTask(db, plan, { status: "opened", wave: 0, prStatus: "converging" });
  addTask(db, plan, { status: "blocked", wave: 0 });
  // Wave 1 — an escalated slice (its PR still escalated) and a skipped slice.
  addTask(db, plan, { status: "escalated", wave: 1, prStatus: "escalated" });
  addTask(db, plan, { status: "skipped", wave: 1 });

  const rows = db.prepare("SELECT wave, total, merged, in_flight, blocked, escalated, skipped, bar FROM plan_wave_summary WHERE plan_key = ? ORDER BY wave").all(plan) as Array<Record<string, unknown>>;
  assertEquals(rows.length, 2);
  assertEquals(rows[0].bar, "▓▓▓░░ 3/5 merged · 1 in-flight · 1 blocked");
  assertEquals(rows[1].bar, "░░ 0/2 merged · 1 escalated · 1 skipped");

  // A merged PR wins over the task's own status (the PR-merged predicate), and un-levelized (NULL wave)
  // tasks are excluded from every wave row.
  addPlan(db, "o/r#bar2", { status: "done" });
  addTask(db, "o/r#bar2", { status: "escalated", wave: 0, prStatus: "merged" });
  addTask(db, "o/r#bar2", { status: "pending", wave: null });
  const r2 = db.prepare("SELECT wave, total, merged, escalated FROM plan_wave_summary WHERE plan_key = ?").all("o/r#bar2") as Array<Record<string, unknown>>;
  assertEquals(r2.length, 1);
  assertEquals({ ...r2[0] }, { wave: 0, total: 1, merged: 1, escalated: 0 });
});

test("plan_wave_tasks carries each task's PR url + process_key link targets (unchanged display VIEW)", () => {
  const db = viewDb();
  addPlan(db, "o/r#lt", { status: "done" });
  addTask(db, "o/r#lt", { status: "opened", wave: 0, prStatus: "converging" });
  addTask(db, "o/r#lt", { status: "blocked", wave: 0 }); // no PR → null link targets
  const rows = db.prepare("SELECT pr_key, pr_url, process_key FROM plan_wave_tasks WHERE plan_key = ? ORDER BY task_index").all("o/r#lt") as Array<Record<string, unknown>>;
  assert(rows[0].pr_url != null && rows[0].process_key != null, "an opened slice links to its PR url + process instance");
  assertEquals({ pr_url: rows[1].pr_url, process_key: rows[1].process_key }, { pr_url: null, process_key: null });
});

test("the operator pages bind the derived plan-family VIEWs (never the raw plans table)", () => {
  // Overview + Epic index + Epic detail all read the composite `plan_read_model`; the epic-detail
  // per-wave summary reads `plan_wave_summary` (the bar), and the wave-state grid `plan_wave_tasks`.
  const overview = PAGE("overview.page.json");
  const epics = (overview.nodes ?? []).find((n: { id: string }) => n.id === "overview-epics");
  assert(epics, "overview must keep the epics grid");
  assertEquals(epics.props.data.table, "plan_read_model");

  const epicIndex = PAGE("epic.page.json");
  const epicPlans = (epicIndex.nodes ?? []).find((n: { props?: { data?: { table?: string } } }) => n.props?.data?.table === "plan_read_model");
  assert(epicPlans, "the Epics index grid must read the derived plan_read_model VIEW");

  const detail = PAGE("epic-detail.page.json");
  const byId = (id: string) => (detail.nodes ?? []).find((n: { id: string }) => n.id === id);
  assertEquals(byId("wave-banner").props.data.table, "plan_read_model");
  assertEquals(byId("wave-summary").props.data.table, "plan_wave_summary");
  const summaryCols: string[] = byId("wave-summary").props.columns.map((c: { field: string }) => c.field);
  for (const f of ["wave", "bar", "merged", "in_flight", "blocked", "escalated", "skipped", "total"]) {
    assert(summaryCols.includes(f), `the summary grid shows ${f}`);
  }
  assertEquals(byId("wave-state").props.data.table, "plan_wave_tasks");
});

test("the app/delivery.ts adapters route through the framework backends (planDeliveryCounts.reduce + planReadModel.evaluate) — the wave rollups compose", () => {
  // A guard that the declared rollups are wired as the adapters' engine: the two count rollups fold the
  // same slice-PR partition, and the composed wave-progress rollup reads the wave-counts rollup.
  assertEquals(planWaveProgress.sourceRelations.slice().sort(), ["plan_tasks", "pull_requests"]);
  assertEquals(planWaveCounts.groupBy, ["plan_key", "wave"]);
  assertEquals(planDeliveryCounts.groupBy, ["plan_key"]);
  // The adapters produce the framework-folded counts (deriveDelivery is the reduce()+evaluate() façade).
  const r = deriveDelivery("done", ["merged", "waiting_review", "missing"]);
  assertEquals({ prsOpened: r.prsOpened, prsMerged: r.prsMerged, prsInFlight: r.prsInFlight }, { prsOpened: 3, prsMerged: 1, prsInFlight: 2 });
  assertEquals(r.delivery, "converging");
  assertEquals(r.label, "1/3 slices merged, 2 converging");
});
