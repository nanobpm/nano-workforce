// Read-model VIEW coverage for the feature-run pipeline projection (issue #439 — the status-driven
// follow-up to epic #412, "Retire worker-maintained denormalized projections in favour of SQL
// VIEWs").
//
// 039_feature_pipeline_stage.sql denormalised the pipeline projection
// (`stage`/`stage_state`/`stage_skipped`/`attention`/`list_bucket`) onto the `feature_runs` row,
// written by the `featureRuns()` gateway (app/feature.ts) at WRITE TIME from the pure `deriveStage` /
// `deriveListBucket` (app/stage.ts). That "the gateway is the sole write path" invariant did NOT hold
// for the framework `instanceTracking` reconciler, which writes `feature_runs.status` through the RAW
// datasource on a terminated instance — bypassing the gateway and freezing the display columns.
// 073_feature_read_model.sql retires the write-time projection: the derived columns are now a VIEW
// over each row's own `status`/`pr_key`/`converge`/`auto_merge`/`acknowledged_at`, so there is no
// stored column and no write-path for any writer to leave stale. 075_feature_read_model_attention_
// from_user_tasks.sql then moves `attention` off the drift-prone `status` variable onto ENGINE TRUTH
// — an OPEN `feature-blocked`/`feature-escalation` row in the `user_tasks` inbox (issue #422).
//
// This exercises the REAL SQLite view (073+075 applied to an in-memory DB, mirroring
// app/plansReadModel.test.ts / app/mergesPerDayView.test.ts) and pins that its CASE expressions
// reproduce `deriveStage` / `deriveListBucket` EXACTLY over the full status × open-task matrix — the
// SAME pure helpers the acknowledge operations guard on — plus RED/GREEN guards reproducing the
// reconciler bypass (a RAW-datasource `status` write must leave the projection correct) and the #422
// answered-escalation drift (a sticky `status='escalated'` with no open task must show no ⚠).
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "#test-assert";
import { FEATURE_RUN_STATUSES } from "./feature.ts";
import { deriveListBucket, deriveStage } from "./stage.ts";

const MIG = (name: string) => readFileSync(fileURLToPath(new URL(`../db/migrations/${name}`, import.meta.url)), "utf8");
const PAGE = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../pages/${name}`, import.meta.url)), "utf8"));

// The base `feature_runs` shape the view reads (028 + 030's delivery_label + 035's title + 039's
// acknowledged_at & the now-vestigial stored stage/… columns), plus migration 073. The stored derived
// columns are present precisely so the tests can seed STALE values and prove the VIEW ignores them.
function viewDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE feature_runs (
       feature_key TEXT PRIMARY KEY, repo TEXT, issue_number INTEGER, issue_url TEXT, title TEXT,
       base_branch TEXT, status TEXT, process_key TEXT, pr_key TEXT, converge INTEGER, auto_merge INTEGER,
       outcome TEXT, delivery_label TEXT, acknowledged_at TEXT, created_at TEXT, updated_at TEXT,
       stage TEXT, stage_state TEXT, stage_skipped TEXT, attention TEXT, list_bucket TEXT);`,
  );
  // The `user_tasks` inbox (034_user_tasks_inbox.sql) — the engine-truth source the 075 VIEW derives
  // `attention` from (a row IFF an escalation user task is OPEN). Minimal shape: the three columns the
  // correlated EXISTS lookups read, plus its PK.
  db.exec(
    `CREATE TABLE user_tasks (
       user_task_key TEXT PRIMARY KEY, element_id TEXT NOT NULL, subject_type TEXT NOT NULL,
       subject_key TEXT NOT NULL);`,
  );
  db.exec(MIG("073_feature_read_model.sql"));
  db.exec(MIG("075_feature_read_model_attention_from_user_tasks.sql"));
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
  // in a different status). The VIEW must ignore these and re-derive from `status`.
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

test("feature_read_model derives stage/stage_state/stage_skipped/attention EXACTLY like deriveStage, over every status × converge/auto_merge/pr_key × open-task combination", () => {
  const db = viewDb();
  const cases: Array<{ key: string; run: SampleRun; hasOpenBlockedTask: boolean; hasOpenEscalationTask: boolean }> = [];
  let i = 0;
  for (const status of FEATURE_RUN_STATUSES) {
    for (const converge of [0, 1]) {
      for (const auto_merge of [0, 1]) {
        for (const pr_key of [null, `o/r#pr${i}`]) {
          // The open-task dimension: for the two human-wait statuses, exercise BOTH task-present and
          // task-absent (the #422 drift case = escalated/awaiting_operator with the task already gone).
          for (const openTask of [false, true]) {
            const key = `o/r#${i++}`;
            const el = status === "escalated" ? "feature-escalation" : status === "awaiting_operator" ? "feature-blocked" : null;
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

test("feature_read_model derives list_bucket EXACTLY like deriveListBucket (history iff terminal AND acknowledged)", () => {
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

test("feature_read_model IGNORES any stale STORED projection columns — it reads only from status et al.", () => {
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
  // until its next agent job completes (observed live on merlin: feature instance 31779). The OLD VIEW
  // derived `attention` from that value and rendered a stale ⚠ on Overview. The badge now derives from
  // engine truth — the presence of an OPEN `feature-escalation` user task (`pollUserTasks` deletes the
  // row the moment it is answered) — so it clears immediately regardless of the stale status.
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
  // bypassing the (now retired) projecting `featureRuns` gateway. Under the OLD write-time projection
  // the stored `stage`/`stage_state`/`attention`/`list_bucket` would FREEZE at their pre-terminal
  // values — the merlin symptom: a cancelled run wedged in Active as a live-looking `Implementing ⚠`,
  // its Dismiss gated shut on a NULL stage_state. Because the projection is now a VIEW over `status`,
  // the read model stays correct with no write-path for any writer to leave it stale.
  const db = viewDb();
  // A live run mid-flight — its (soon-stale) stored projection says Implementing / ⚠ / active.
  addRun(db, "o/r#kill", {
    status: "running",
    stored: { stage: "Implementing", stage_state: undefined, attention: undefined, list_bucket: "active" },
  });
  assertEquals(projection(db, "o/r#kill").stage, "Implementing", "precondition: live run renders Implementing");

  // The reconciler flips status terminal via the RAW table — NOT the gateway. (Simulated with a raw
  // UPDATE, exactly what the raw datasource emits.) It touches none of the display columns.
  db.prepare("UPDATE feature_runs SET status = 'abandoned' WHERE feature_key = ?").run("o/r#kill");

  const row = projection(db, "o/r#kill");
  const oracle = deriveStage({ status: "abandoned", pr_key: null, converge: 0, auto_merge: 0 });
  // The projection tracks `status` through the VIEW — the merlin drift can no longer happen.
  assertEquals(row.stage, "Done", "an abandoned run is Done, not wedged at Implementing");
  assertEquals(row.stage, oracle.stage);
  assertEquals(row.stage_state, "failed", "abandoned renders a terminal FAILED state (was frozen NULL)");
  assertEquals(row.stage_state, oracle.state);
  assertEquals(row.attention, null, "the stale ⚠ badge is gone");
  assertEquals(row.attention, oracle.attention);
  // Dismiss's `showWhenField` is `stage_state`: a non-null terminal state makes it renderable.
  assert(row.stage_state != null, "Dismiss is renderable (stage_state is non-null) so the run can be ticked off");
  // Unacknowledged terminal → still Active (History only after the operator dismisses it).
  assertEquals(row.list_bucket, "active", "a just-cancelled run sits in Active until dismissed");
  assertEquals(row.list_bucket, deriveListBucket("abandoned", null));
});

test("the Feature page binds the derived feature_read_model VIEW (not the raw feature_runs table)", () => {
  // `feature.page.json`'s runs grid is the ONLY thing making the UI consume the derived projection.
  // `feature_runs` remains a valid schema table, so reverting this binding would leave every SQL-view
  // test green while the display silently resumed reading the stale stored columns; pin it here
  // (suppressed advisory feature.page.json — issue #439).
  const page = PAGE("feature.page.json");
  const runs = (page.nodes ?? []).find((n: { id: string }) => n.id === "feature-runs");
  assert(runs, "feature page must keep the Feature runs grid");
  assertEquals(runs.props.data.table, "feature_read_model");
});
