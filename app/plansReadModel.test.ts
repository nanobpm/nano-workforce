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
import { deriveDelivery, deriveEpicBucket, epicIsAcknowledgeable } from "./delivery.ts";

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
       promotion_pr TEXT, promotion_state TEXT, acknowledged_at TEXT, list_bucket TEXT, ack_open INTEGER,
       derived_status_override TEXT);
     CREATE TABLE plan_tasks (
       id INTEGER PRIMARY KEY, plan_key TEXT, task_index INTEGER, task_id TEXT, title TEXT,
       prompt TEXT, status TEXT, pr_key TEXT, summary TEXT, created_at TEXT, updated_at TEXT,
       wave INTEGER, open_question TEXT, answer TEXT, draft_pr_key TEXT, corr_key TEXT);
     CREATE TABLE pull_requests (pr_key TEXT PRIMARY KEY, url TEXT, status TEXT, process_key TEXT);`,
  );
  // Stand-in for the managed `plans__tracking` VIEW urban provisions at mount (ADR-0065): re-exports
  // `plans.*` plus the `derived_status` the terminal-edge reader (migration 079) reads. A test seeds
  // `derived_status_override` to model the reconciler's derive edge (a terminated instance ⇒
  // `abandoned` while base `status` stays frozen); absent, it falls through to the base `status`, exactly
  // as the real VIEW's `ELSE base.status` branch does.
  db.exec(
    `CREATE VIEW plans__tracking AS
       SELECT p.*, COALESCE(p.derived_status_override, p.status) AS derived_status FROM plans p;`,
  );
  db.exec(MIG("059_plan_wave_summary.sql"));
  db.exec(MIG("060_plan_wave_rollup.sql"));
  db.exec(MIG("061_plan_delivery_rollup.sql"));
  // 074 redefines plan_read_model to DERIVE list_bucket/ack_open from status + acknowledged_at + the
  // derived plan_delivery signal (issue #439), instead of reading the denormalised base columns.
  db.exec(MIG("074_plan_read_model_derive_bucket.sql"));
  // 079 re-points plan_read_model's status/bucket derivations at the derived plans__tracking VIEW so a
  // terminated (derive-only `abandoned`) epic drops out of Active (issue #503).
  db.exec(MIG("079_plan_read_model_derive_terminal.sql"));
  return db;
}

interface SampleTask {
  status: string;
  wave: number | null;
  pr?: { status: string };
  // A slice that OPENED a PR (so `pr_key` is set and it counts toward `prs_opened`) but whose
  // `pull_requests` row is ABSENT — a DB desync. Mirrors `pollDelivery`'s `MISSING_PR_STATUS`
  // sentinel: the LEFT JOIN yields `status IS NULL`, which `plan_delivery_counts` treats as
  // in-flight (non-terminal), so it can never wrongly promote an epic to `landed`.
  danglingPr?: boolean;
}

// Sentinel mirroring `pollDelivery`'s `MISSING_PR_STATUS` — the status fed to `deriveDelivery` for a
// `pr_key` with no `pull_requests` row. Any non-terminal string works (it's counted as in-flight); it
// exists only to keep the `deriveDelivery` cross-check aligned with the view's `status IS NULL` branch.
const MISSING_PR_STATUS = "missing";

// Insert a plan plus its tasks (and each task's PR, if any). PR keys are derived so the test rows
// stay terse. Returns the flat `pull_requests.status` list `deriveDelivery` consumes (only tasks
// that opened a PR), so the delivery assertions can cross-check the view against it.
function addPlan(
  db: DatabaseSync,
  plan_key: string,
  status: string,
  tasks: SampleTask[],
  opts: { acknowledged_at?: string | null } = {},
): string[] {
  db.prepare(
    "INSERT INTO plans (plan_key, repo, issue_number, issue_url, status, task_count, updated_at, acknowledged_at, list_bucket) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(plan_key, "o/r", 1, `https://gh/${plan_key}`, status, tasks.length, "2026-01-01T00:00:00Z", opts.acknowledged_at ?? null, "active");
  const prStatuses: string[] = [];
  tasks.forEach((t, i) => {
    const prKey = t.pr || t.danglingPr ? `${plan_key}::pr${i}` : null;
    db.prepare(
      "INSERT INTO plan_tasks (plan_key, task_index, task_id, status, pr_key, wave) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(plan_key, i, `t${i}`, t.status, prKey, t.wave);
    if (t.danglingPr) {
      // Opened a PR (pr_key set → counts toward prs_opened) but NO `pull_requests` row: the DB desync
      // `pollDelivery` feeds to `deriveDelivery` as MISSING_PR_STATUS (in-flight).
      prStatuses.push(MISSING_PR_STATUS);
    } else if (t.pr && prKey) {
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

function counts(db: DatabaseSync, plan_key: string): { prs_opened: number; prs_merged: number; prs_in_flight: number } {
  const r = db
    .prepare("SELECT prs_opened, prs_merged, prs_in_flight FROM plan_delivery_counts WHERE plan_key = ?")
    .get(plan_key) as { prs_opened: number; prs_merged: number; prs_in_flight: number };
  return { ...r };
}

// The derived Active/History bucket flags the epics pages bind — read straight off `plan_read_model`
// (074), plus the delivery signal the derivation folds in, so the assertions can cross-check the
// VIEW against the pure `deriveEpicBucket` / `epicIsAcknowledgeable` oracles.
function bucket(db: DatabaseSync, plan_key: string): { list_bucket: unknown; ack_open: unknown; delivery: string | null } {
  const r = db
    .prepare("SELECT list_bucket, ack_open, delivery FROM plan_read_model WHERE plan_key = ?")
    .get(plan_key) as { list_bucket: unknown; ack_open: unknown; delivery: string | null };
  return { ...r };
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

test("plan_delivery_counts pins the two subtle predicates: `converged` is terminal, a dangling pr_key is in-flight", () => {
  const db = viewDb();
  // `converged` is in TERMINAL_STATUSES (review-only mode): a `done` epic whose only remaining PR is
  // `converged` (not `merged`) is resolved-not-landed. It must NOT count as in-flight — so delivery is
  // NULL, never `converging`. This pins the hard-coded terminal set in the view's SQL against
  // TERMINAL_STATUSES; drop `converged` from either and prs_in_flight becomes 1 here.
  const conv = addPlan(db, "o/r#c", "done", [
    { status: "opened", wave: 0, pr: { status: "merged" } },
    { status: "opened", wave: 0, pr: { status: "converged" } },
  ]);
  assertEquals(counts(db, "o/r#c"), { prs_opened: 2, prs_merged: 1, prs_in_flight: 0 });
  assertEquals(delivery(db, "o/r#c").delivery, null, "converged is terminal-not-merged → resolved, not landed");
  assertEquals({ ...delivery(db, "o/r#c") }, { delivery: deriveDelivery("done", conv).delivery, delivery_label: deriveDelivery("done", conv).label });

  // A dangling `pr_key` (task opened a PR but the `pull_requests` row is absent — the poller's
  // MISSING_PR_STATUS desync). The LEFT JOIN yields `status IS NULL`, which the view's
  // `p.status IS NULL OR …` branch counts as in-flight — so even though every OTHER PR merged, the
  // epic stays `converging` and can never be wrongly promoted to `landed`.
  const dangling = addPlan(db, "o/r#d", "done", [
    { status: "opened", wave: 0, pr: { status: "merged" } },
    { status: "opened", wave: 0, danglingPr: true },
  ]);
  assertEquals(counts(db, "o/r#d"), { prs_opened: 2, prs_merged: 1, prs_in_flight: 1 });
  assertEquals(delivery(db, "o/r#d").delivery, "converging", "a dangling pr_key keeps the epic in flight (never landed)");
  assertEquals({ ...delivery(db, "o/r#d") }, {
    delivery: deriveDelivery("done", dangling).delivery,
    delivery_label: deriveDelivery("done", dangling).label,
  });
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

  // Epic INDEX page (epic.page.json) — the standalone Epics grid must also read the derived VIEW, not
  // the raw `plans` table. `plans` stays a valid schema table, so a regression here (reverting the
  // binding) would leave every OTHER test green while the index silently resumed reading stale
  // list_bucket/ack_open; this pins it (suppressed advisory epic.page.json — issue #439).
  const epicIndex = PAGE("epic.page.json");
  const epicPlans = (epicIndex.nodes ?? []).find((n: { id: string }) => n.id === "epic-plans");
  assert(epicPlans, "epic index must keep the Epics grid");
  assertEquals(epicPlans.props.data.table, "plan_read_model");
});

test("plan_read_model DERIVES list_bucket / ack_open from status + delivery + acknowledged_at, matching deriveEpicBucket / epicIsAcknowledgeable (issue #439)", () => {
  const db = viewDb();
  // done, still converging (a slice in flight): Active, Dismiss suppressed — never ticked off mid-flight.
  const converging = addPlan(db, "o/r#conv", "done", [
    { status: "opened", wave: 0, pr: { status: "merged" } },
    { status: "opened", wave: 1, pr: { status: "converging" } },
  ]);
  // done, fully landed, unacknowledged: Active with Dismiss OPEN (ack_open=1).
  const landed = addPlan(db, "o/r#land", "done", [
    { status: "opened", wave: 0, pr: { status: "merged" } },
    { status: "opened", wave: 0, pr: { status: "merged" } },
  ]);
  // done, landed AND acknowledged: History, Dismiss closed.
  const acked = addPlan(
    db,
    "o/r#ack",
    "done",
    [{ status: "opened", wave: 0, pr: { status: "merged" } }],
    { acknowledged_at: "2026-02-02T00:00:00Z" },
  );
  // resolved-not-landed (one abandoned), unacknowledged: delivery null → acknowledgeable, Active + Dismiss.
  const resolved = addPlan(db, "o/r#res", "done", [
    { status: "opened", wave: 0, pr: { status: "merged" } },
    { status: "opened", wave: 0, pr: { status: "abandoned" } },
  ]);
  // live (dispatched) epic: Active, not acknowledgeable.
  const live = addPlan(db, "o/r#live", "dispatched", [{ status: "opened", wave: 0, pr: { status: "converging" } }]);

  for (const [plan_key, status, prStatuses, ackAt] of [
    ["o/r#conv", "done", converging, null],
    ["o/r#land", "done", landed, null],
    ["o/r#ack", "done", acked, "2026-02-02T00:00:00Z"],
    ["o/r#res", "done", resolved, null],
    ["o/r#live", "dispatched", live, null],
  ] as const) {
    const b = bucket(db, plan_key);
    const expectedDelivery = deriveDelivery(status, prStatuses).delivery;
    assertEquals(b.delivery, expectedDelivery, `${plan_key}: delivery`);
    // Cross-check the VIEW against the pure helpers — the SAME oracle the acknowledge-epic op guards on.
    assertEquals(
      b.list_bucket,
      deriveEpicBucket(status, expectedDelivery, ackAt),
      `${plan_key}: list_bucket must equal deriveEpicBucket`,
    );
    const expectedAckOpen = epicIsAcknowledgeable(status, expectedDelivery) && ackAt === null ? 1 : 0;
    assertEquals(b.ack_open, expectedAckOpen, `${plan_key}: ack_open must equal epicIsAcknowledgeable`);
  }

  // Pin the human-visible outcomes so a derivation drift can't hide behind the cross-check.
  assertEquals(bucket(db, "o/r#conv"), { list_bucket: "active", ack_open: 0, delivery: "converging" });
  assertEquals(bucket(db, "o/r#land"), { list_bucket: "active", ack_open: 1, delivery: "landed" });
  assertEquals(bucket(db, "o/r#ack"), { list_bucket: "history", ack_open: 0, delivery: "landed" });
  assertEquals(bucket(db, "o/r#res"), { list_bucket: "active", ack_open: 1, delivery: null });
  assertEquals(bucket(db, "o/r#live"), { list_bucket: "active", ack_open: 0, delivery: null });
});

test("RED/GREEN GUARD: a RAW-datasource plans.status write (the instanceTracking reconciler bypass) leaves plan_read_model's bucket CONSISTENT", () => {
  // Reproduce the framework `instanceTracking` reconciler class of bug: on a terminated process
  // instance it writes `{status:"abandoned"}` to `plans` through the RAW datasource — bypassing the
  // (now retired) projecting `plans` gateway. Under the OLD write-time projection the stored
  // `list_bucket`/`ack_open` would freeze at their pre-terminal values; because they are now a VIEW
  // over `status`, the read model stays correct with no write-path for any writer to leave stale.
  const db = viewDb();
  // A live epic mid-flight — Active, its (stale) stored projection says active/converging.
  addPlan(db, "o/r#kill", "dispatched", [{ status: "opened", wave: 0, pr: { status: "converging" } }]);
  assertEquals(bucket(db, "o/r#kill").list_bucket, "active");

  // The reconciler flips status terminal via the RAW table — NOT the gateway. (Simulated with a raw
  // UPDATE, exactly what the raw datasource emits.) It touches neither list_bucket nor ack_open.
  db.prepare("UPDATE plans SET status = 'abandoned' WHERE plan_key = ?").run("o/r#kill");

  // `abandoned` is a terminal non-`done` status: History, never acknowledgeable — matches the oracle.
  const b = bucket(db, "o/r#kill");
  assertEquals(b.list_bucket, deriveEpicBucket("abandoned", b.delivery, null), "list_bucket tracks status via the VIEW");
  assertEquals(b.list_bucket, "history", "an abandoned epic is filed under History, not wedged in Active");
  assertEquals(b.ack_open, epicIsAcknowledgeable("abandoned", b.delivery) ? 1 : 0);
  assertEquals(b.ack_open, 0, "no phantom Dismiss on a reconciler-cancelled epic");
});

test("RED/GREEN #503: a DERIVE-ONLY terminated epic (base status frozen, derived_status='abandoned') drops out of Active", () => {
  // ADR-0065 (urban 0.81.0): cancel/terminate is DERIVE-ONLY — the reconciler feeds urban's projection
  // and `plans__tracking.derived_status` recomputes `abandoned` on READ; it does NOT write the terminal
  // onto the base `plans.status` column. So the base row stays frozen at its last transient
  // (`dispatched`) while the epic is really terminated. Before 079 `plan_read_model` bucketed off the
  // frozen base column and rendered the dead epic ACTIVE on the epic index/detail forever (the #503 /
  // #497 phantom). 079 reads the effective status off `plans__tracking`, so it drops to History.
  const db = viewDb();
  // Seed a plan whose engine instance was terminated out-of-band: base status still `dispatched`, but
  // the derive edge reports `abandoned` (modelled via the plans__tracking stand-in's override column).
  db.prepare(
    "INSERT INTO plans (plan_key, repo, issue_number, issue_url, status, task_count, updated_at, acknowledged_at, list_bucket, derived_status_override) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("o/r#term", "o/r", 7, "https://gh/o/r#term", "dispatched", 0, "2026-01-01T00:00:00Z", null, "active", "abandoned");

  const r = db
    .prepare("SELECT status, list_bucket, ack_open FROM plan_read_model WHERE plan_key = ?")
    .get("o/r#term") as { status: string; list_bucket: string; ack_open: number };

  assertEquals(r.status, "abandoned", "plan_read_model surfaces the DERIVED terminal, not the frozen base transient");
  assertEquals(r.list_bucket, "history", "a derive-only terminated epic is filed under History, not wedged Active");
  assertEquals(r.list_bucket, deriveEpicBucket("abandoned", null, null));
  assertEquals(r.ack_open, 0, "no phantom Dismiss on a derive-only terminated epic");
});
