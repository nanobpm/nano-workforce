// Read-model coverage for the feature-run pipeline projection (issues #412 → #439 → #422), now
// authored via Urban's ADR-0065 declare-once primitive (`defineReadModel`, app/featureReadModel.ts).
//
// 039_feature_pipeline_stage.sql denormalised the projection (`stage`/`stage_state`/`stage_skipped`/
// `attention`/`list_bucket`) onto the `feature_runs` row at WRITE TIME; 073 retired that into a VIEW
// over each row's own columns; 075 moved `attention` onto ENGINE TRUTH (an OPEN `user_tasks` row,
// issue #422). Each of those hand-wired the derived columns TWICE — the SQL CASE/EXISTS AND the TS
// oracle (`deriveStage`/`deriveListBucket`) — kept in lockstep by a bespoke parity test (drift
// surface #2). 076_feature_read_model_declare_once.sql supersedes them: every derived column is now
// emitted from the ONE `featureReadModel` declaration, which ALSO drives the TS via `fnFor`. This
// suite therefore guards THREE things:
//
//   1. DRIFT GUARD — migration 076 embeds each derived column's SQL VERBATIM from
//      `featureReadModel.sqlSelectFor(...)`, so the checked-in VIEW cannot drift from the declaration.
//   2. FRAMEWORK PARITY GUARD — `assertReadModelParity` proves the SQL and TS lowerings the ONE
//      declaration compiles to agree (the role the old hand-written lockstep test played, now
//      framework-owned).
//   3. END-TO-END BEHAVIOUR on the REAL migration VIEW (076 applied to an in-memory DB): the full
//      status × open-task matrix vs the model-derived oracle, the stale-stored-column ignore, the
//      reconciler `status`-bypass, the #422 answered-escalation drift, and the page binding.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertReadModelParity, type ParityDb, type ParitySample } from "@nanobpm/urban";
import { assert, assertEquals } from "#test-assert";
import { FEATURE_RUN_STATUSES } from "./feature.ts";
import { FEATURE_READ_MODEL_BASE_ALIAS, FEATURE_READ_MODEL_DERIVED, featureReadModel } from "./featureReadModel.ts";
import { deriveListBucket, deriveStage } from "./stage.ts";

const MIG = (name: string) => readFileSync(fileURLToPath(new URL(`../db/migrations/${name}`, import.meta.url)), "utf8");
const PAGE = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../pages/${name}`, import.meta.url)), "utf8"));

const MIGRATION_076 = "076_feature_read_model_declare_once.sql";

// The base `feature_runs` shape the VIEW reads, plus the `user_tasks` inbox (034) the `attention`
// derivation `EXISTS`-reads. The stored derived columns are present precisely so the tests can seed
// STALE values and prove the VIEW ignores them.
function viewDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE feature_runs (
       feature_key TEXT PRIMARY KEY, repo TEXT, issue_number INTEGER, issue_url TEXT, title TEXT,
       base_branch TEXT, status TEXT, process_key TEXT, pr_key TEXT, converge INTEGER, auto_merge INTEGER,
       outcome TEXT, delivery_label TEXT, acknowledged_at TEXT, created_at TEXT, updated_at TEXT,
       stage TEXT, stage_state TEXT, stage_skipped TEXT, attention TEXT, list_bucket TEXT);`,
  );
  db.exec(
    `CREATE TABLE user_tasks (
       user_task_key TEXT PRIMARY KEY, element_id TEXT NOT NULL, subject_type TEXT NOT NULL,
       subject_key TEXT NOT NULL);`,
  );
  db.exec(MIG(MIGRATION_076));
  return db;
}

// Simulate `pollUserTasks` opening one native user task for a feature run: the presence of this row is
// the engine truth the VIEW's `attention` derives from (its deletion = the task answered/closed).
function openUserTask(db: DatabaseSync, feature_key: string, element_id: "feature-escalation" | "feature-blocked"): void {
  db.prepare(
    "INSERT INTO user_tasks (user_task_key, element_id, subject_type, subject_key) VALUES (?, ?, 'feature', ?)",
  ).run(`${feature_key}:${element_id}`, element_id, feature_key);
}

interface SampleRun {
  status: string;
  pr_key?: string | null;
  converge?: number;
  auto_merge?: number;
  acknowledged_at?: string | null;
  // Deliberately-stale STORED projection columns (simulating a row the gateway last projected while
  // in a different status). The VIEW must ignore these and re-derive.
  stored?: Partial<Record<"stage" | "stage_state" | "stage_skipped" | "attention" | "list_bucket", string>>;
}

function addRun(db: DatabaseSync, feature_key: string, run: SampleRun): void {
  const s = run.stored ?? {};
  db.prepare(
    `INSERT INTO feature_runs
       (feature_key, repo, issue_number, issue_url, title, base_branch, status, pr_key, converge,
        auto_merge, acknowledged_at, created_at, updated_at,
        stage, stage_state, stage_skipped, attention, list_bucket)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    feature_key,
    "o/r",
    1,
    `https://gh/${feature_key}`,
    `Feature ${feature_key}`,
    "main",
    run.status,
    run.pr_key ?? null,
    run.converge ?? 0,
    run.auto_merge ?? 0,
    run.acknowledged_at ?? null,
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
    s.stage ?? null,
    s.stage_state ?? null,
    s.stage_skipped ?? null,
    s.attention ?? null,
    s.list_bucket ?? null,
  );
}

function projection(db: DatabaseSync, feature_key: string): Record<string, unknown> {
  const r = db
    .prepare(
      "SELECT stage, stage_state, stage_skipped, attention, list_bucket FROM feature_read_model WHERE feature_key = ?",
    )
    .get(feature_key) as Record<string, unknown>;
  return { ...r };
}

// A `ParityDb` over node:sqlite's `DatabaseSync` for `assertReadModelParity` (which needs positional
// `exec`/`all`/`run`, whereas `DatabaseSync` exposes query methods on prepared statements).
function parityDb(db: DatabaseSync): ParityDb {
  return {
    exec: (sql) => db.exec(sql),
    all: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...(params as never[])) as T[],
    run: (sql, params: unknown[] = []) => {
      const r = db.prepare(sql).run(...(params as never[]));
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    },
  };
}

test("DRIFT GUARD: migration 076 embeds each derived column VERBATIM from featureReadModel.sqlSelectFor (the VIEW cannot drift from the declaration)", () => {
  const sql = MIG(MIGRATION_076);
  for (const col of FEATURE_READ_MODEL_DERIVED) {
    const emitted = featureReadModel.sqlSelectFor(col, { baseAlias: FEATURE_READ_MODEL_BASE_ALIAS });
    assert(
      sql.includes(`${emitted} AS ${col}`),
      `migration ${MIGRATION_076} no longer embeds the declaration's SQL for "${col}" — regenerate it ` +
        `from featureReadModel (or add a new superseding migration). Expected to contain:\n  ${emitted} AS ${col}`,
    );
  }
  // The VIEW is a DROP+CREATE that supersedes 073/075, and keeps every base column as an aliased
  // pass-through so the static pages↔schema contract guard still sees them.
  assert(/DROP VIEW IF EXISTS feature_read_model;/.test(sql), "076 must DROP the superseded VIEW first");
  assert(/CREATE VIEW feature_read_model AS/.test(sql), "076 must (re)create feature_read_model");
  for (const base of ["feature_key", "status", "pr_key", "converge", "auto_merge", "acknowledged_at", "title", "repo"]) {
    assert(sql.includes(`fr.${base} AS ${base}`), `076 must pass base column "${base}" through the VIEW`);
  }
});

test("FRAMEWORK PARITY GUARD: featureReadModel's SQL and TS lowerings agree over the full status × open-task matrix (assertReadModelParity)", () => {
  const samples: ParitySample[] = [];
  for (const status of FEATURE_RUN_STATUSES) {
    for (const converge of [0, 1]) {
      for (const auto_merge of [0, 1]) {
        for (const pr_key of [null, "o/r#pr"]) {
          for (const acknowledged_at of [null, "2026-02-02T00:00:00Z"]) {
            const el = status === "escalated" ? "feature-escalation" : status === "awaiting_operator" ? "feature-blocked" : null;
            for (const openTask of el !== null ? [false, true] : [false]) {
              const userTasks =
                openTask && el !== null ? [{ subject_type: "feature", subject_key: "self", element_id: el }] : [];
              samples.push({
                baseRow: { feature_key: "self", status, pr_key, converge, auto_merge, acknowledged_at },
                projections: { user_tasks: userTasks },
              });
            }
          }
        }
      }
    }
  }
  // A bare in-memory handle: the guard builds/drops its OWN TEMP fixtures, so it needs no schema.
  const db = new DatabaseSync(":memory:");
  assertReadModelParity(featureReadModel, parityDb(db), samples);
  db.close();
});

test("the migration 076 VIEW derives stage/stage_state/stage_skipped/attention EXACTLY like deriveStage, over every status × converge/auto_merge/pr_key × open-task combination", () => {
  const db = viewDb();
  const cases: Array<{ key: string; run: SampleRun; hasOpenBlockedTask: boolean; hasOpenEscalationTask: boolean }> = [];
  let i = 0;
  for (const status of FEATURE_RUN_STATUSES) {
    for (const converge of [0, 1]) {
      for (const auto_merge of [0, 1]) {
        for (const pr_key of [null, `o/r#pr${i}`]) {
          // The open-task dimension only matters for the two human-wait statuses (escalated/
          // awaiting_operator); every other status ignores open tasks, so iterate [false] alone there.
          const el = status === "escalated" ? "feature-escalation" : status === "awaiting_operator" ? "feature-blocked" : null;
          for (const openTask of el !== null ? [false, true] : [false]) {
            const key = `o/r#${i++}`;
            const hasTask = openTask && el !== null;
            cases.push({
              key,
              run: { status, converge, auto_merge, pr_key },
              hasOpenBlockedTask: hasTask && el === "feature-blocked",
              hasOpenEscalationTask: hasTask && el === "feature-escalation",
            });
            addRun(db, key, { status, converge, auto_merge, pr_key });
            if (hasTask && el !== null) openUserTask(db, key, el);
          }
        }
      }
    }
  }

  for (const { key, run, hasOpenBlockedTask, hasOpenEscalationTask } of cases) {
    const oracle = deriveStage({
      status: run.status,
      pr_key: run.pr_key ?? null,
      converge: run.converge ?? 0,
      auto_merge: run.auto_merge ?? 0,
      hasOpenBlockedTask,
      hasOpenEscalationTask,
    });
    const row = projection(db, key);
    assertEquals(row.stage, oracle.stage, `${key} (status=${run.status}): stage`);
    assertEquals(row.stage_state, oracle.state, `${key} (status=${run.status}): stage_state`);
    assertEquals(row.stage_skipped, oracle.skipped, `${key} (status=${run.status}): stage_skipped`);
    assertEquals(row.attention, oracle.attention, `${key} (status=${run.status}, openBlocked=${hasOpenBlockedTask}, openEsc=${hasOpenEscalationTask}): attention`);
  }
});

test("the migration 076 VIEW derives list_bucket EXACTLY like deriveListBucket (history iff terminal AND acknowledged)", () => {
  const db = viewDb();
  let i = 0;
  const cases: Array<{ key: string; status: string; ackAt: string | null }> = [];
  for (const status of FEATURE_RUN_STATUSES) {
    for (const ackAt of [null, "2026-02-02T00:00:00Z"]) {
      const key = `o/r#lb${i++}`;
      cases.push({ key, status, ackAt });
      addRun(db, key, { status, acknowledged_at: ackAt });
    }
  }
  for (const { key, status, ackAt } of cases) {
    assertEquals(
      projection(db, key).list_bucket,
      deriveListBucket(status, ackAt),
      `${key} (status=${status}, acknowledged=${ackAt !== null}): list_bucket`,
    );
  }
});

test("the migration 076 VIEW IGNORES any stale STORED projection columns — it reads only from status et al.", () => {
  const db = viewDb();
  // A merged run whose STORED columns lie (frozen from when it was `running`). The VIEW must re-derive.
  addRun(db, "o/r#stale", {
    status: "merged",
    acknowledged_at: "2026-02-02T00:00:00Z",
    stored: { stage: "Implementing", stage_state: undefined, attention: "⚠", list_bucket: "active" },
  });
  assertEquals(projection(db, "o/r#stale"), {
    stage: "Done",
    stage_state: "ok",
    stage_skipped: "Converging Merging",
    attention: null,
    list_bucket: "history",
  });
});

test("RED/GREEN GUARD #422: an ANSWERED escalation (status sticky 'escalated', no open user task) shows NO ⚠; the badge tracks the OPEN task, not status", () => {
  // The `feature` process answer-loop returns the token to `implement-task` without resetting the
  // `status` variable, so a run whose escalation was already answered still reads `status="escalated"`
  // until its next agent job completes (observed live on merlin: feature instance 31779). The badge
  // now derives from engine truth — the presence of an OPEN `feature-escalation` user task
  // (`pollUserTasks` deletes the row the moment it is answered) — so it clears immediately regardless
  // of the stale status.
  const db = viewDb();

  // Answered escalation: status STILL 'escalated' (stale) + a stored ⚠ that lied, but NO open task.
  addRun(db, "o/r#answered", { status: "escalated", stored: { attention: "⚠", stage: "Implementing" } });
  const answered = projection(db, "o/r#answered");
  assertEquals(answered.attention, null, "the stale ⚠ is gone once the escalation task is closed");
  assertEquals(answered.stage, "Implementing", "the run is back implementing (stage unchanged, correct either way)");

  // Genuinely-parked escalation: the SAME status, but its `feature-escalation` user task is OPEN → ⚠.
  addRun(db, "o/r#parked", { status: "escalated" });
  openUserTask(db, "o/r#parked", "feature-escalation");
  assertEquals(projection(db, "o/r#parked").attention, "⚠", "an OPEN escalation task shows ⚠");

  // Answering it (deleting the row — what `pollUserTasks` does) clears the badge with status untouched.
  db.prepare("DELETE FROM user_tasks WHERE subject_key = ?").run("o/r#parked");
  assertEquals(projection(db, "o/r#parked").attention, null, "closing the task clears ⚠ though status is still 'escalated'");

  // Symmetric operator/blocked wait: 'blocked' glyph IFF an open `feature-blocked` task exists.
  addRun(db, "o/r#stuck", { status: "awaiting_operator", stored: { attention: "blocked" } });
  assertEquals(projection(db, "o/r#stuck").attention, null, "no open feature-blocked task → no glyph despite awaiting_operator");
  openUserTask(db, "o/r#stuck", "feature-blocked");
  assertEquals(projection(db, "o/r#stuck").attention, "blocked", "an OPEN feature-blocked task shows the blocked glyph");
});

test("RED/GREEN GUARD: a RAW-datasource feature_runs.status write (the instanceTracking reconciler bypass) leaves the projection CORRECT (stage=Done, terminal stage_state, attention=null, Dismiss renderable, still Active)", () => {
  // Reproduce the framework `instanceTracking` reconciler class of bug: on a terminated (cancelled)
  // process instance it writes `{status:"abandoned"}` to `feature_runs` through the RAW datasource,
  // bypassing the (now retired) projecting `featureRuns` gateway. Because the projection is a VIEW over
  // `status`, the read model stays correct with no write-path for any writer to leave it stale.
  const db = viewDb();
  addRun(db, "o/r#kill", {
    status: "running",
    stored: { stage: "Implementing", stage_state: undefined, attention: undefined, list_bucket: "active" },
  });
  assertEquals(projection(db, "o/r#kill").stage, "Implementing", "precondition: live run renders Implementing");

  db.prepare("UPDATE feature_runs SET status = 'abandoned' WHERE feature_key = ?").run("o/r#kill");

  const row = projection(db, "o/r#kill");
  const oracle = deriveStage({ status: "abandoned", pr_key: null, converge: 0, auto_merge: 0 });
  assertEquals(row.stage, "Done", "an abandoned run is Done, not wedged at Implementing");
  assertEquals(row.stage, oracle.stage);
  assertEquals(row.stage_state, "failed", "abandoned renders a terminal FAILED state (was frozen NULL)");
  assertEquals(row.stage_state, oracle.state);
  assertEquals(row.attention, null, "the stale ⚠ badge is gone");
  assertEquals(row.attention, oracle.attention);
  assert(row.stage_state != null, "Dismiss is renderable (stage_state is non-null) so the run can be ticked off");
  assertEquals(row.list_bucket, "active", "a just-cancelled run sits in Active until dismissed");
  assertEquals(row.list_bucket, deriveListBucket("abandoned", null));
});

test("the Feature page binds the derived feature_read_model VIEW (not the raw feature_runs table)", () => {
  // `feature.page.json`'s runs grid is the ONLY thing making the UI consume the derived projection.
  const page = PAGE("feature.page.json");
  const runs = (page.nodes ?? []).find((n: { id: string }) => n.id === "feature-runs");
  assert(runs, "feature page must keep the Feature runs grid");
  assertEquals(runs.props.data.table, "feature_read_model");
});
