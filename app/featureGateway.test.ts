// Tests for the feature_runs gateway's write-time pipeline projection (issue #254 §1/§3) and the
// one-shot backfill. The gateway wraps the plain table so EVERY writer — no matter which module —
// automatically gets a fresh `stage`/`stage_state`/`stage_skipped`/`attention`/`list_bucket`
// projection, without passing them: the single write path is the only place `deriveStage` /
// `deriveListBucket` are applied.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import { backfillFeatureStages, featureRuns } from "./feature.ts";

// An in-memory record gateway with the same semantics the real Table exposes (get/all/find/insert/
// update). The featureRuns proxy wraps whatever data.table returns, so this exercises the real proxy.
function memData(): { data: DataLayer; rows: any[] } {
  const rows: any[] = [];
  function tbl(_name: string, pk = "id") {
    const match = (r: any, where: any) => Object.entries(where).every(([k, v]) => r[k] === v);
    return {
      async all() {
        return rows.slice();
      },
      async get(id: any) {
        return rows.find((r) => r[pk] === id);
      },
      async find(where: any = {}) {
        return rows.filter((r) => match(r, where));
      },
      async insert(row: any) {
        rows.push({ ...row });
        return row[pk];
      },
      async update(id: any, patch: any) {
        const r = rows.find((row) => row[pk] === id);
        if (r) Object.assign(r, patch);
        return r ? 1 : 0;
      },
    };
  }
  const data = { table: (n: string, pk?: string) => tbl(n, pk) } as any as DataLayer;
  return { data, rows };
}

test("update with only {status:'opened'} projects PR open / null / active without the caller passing them", async () => {
  const { data, rows } = memData();
  rows.push({ feature_key: "o/r#1", status: "running", pr_key: null, converge: 1, auto_merge: 1 });
  await featureRuns(data).update("o/r#1", { status: "opened" });
  assertEquals(rows[0].stage, "PR open");
  assertEquals(rows[0].stage_state, null);
  assertEquals(rows[0].list_bucket, "active");
});

test("update {status:'failed'} projects Done / failed", async () => {
  const { data, rows } = memData();
  rows.push({ feature_key: "o/r#2", status: "running", converge: 1, auto_merge: 1 });
  await featureRuns(data).update("o/r#2", { status: "failed" });
  assertEquals(rows[0].stage, "Done");
  assertEquals(rows[0].stage_state, "failed");
});

test("update {status:'blocked'} projects Done / blocked", async () => {
  const { data, rows } = memData();
  rows.push({ feature_key: "o/r#3", status: "running", converge: 1, auto_merge: 1 });
  await featureRuns(data).update("o/r#3", { status: "blocked" });
  assertEquals(rows[0].stage, "Done");
  assertEquals(rows[0].stage_state, "blocked");
});

test("update {status:'escalated'} on a row with no pr_key projects Implementing / null", async () => {
  const { data, rows } = memData();
  rows.push({ feature_key: "o/r#4", status: "running", pr_key: null, converge: 1, auto_merge: 1 });
  await featureRuns(data).update("o/r#4", { status: "escalated" });
  assertEquals(rows[0].stage, "Implementing");
  assertEquals(rows[0].stage_state, null);
});

// issue #272: the fail-closed open-escalation projection. The escalation tuple is spread across three
// independently-written columns; the gateway projects `escalation_open=1` ONLY when all three agree.
test("escalation_open is 1 only when status=escalated AND pointer AND question all present", async () => {
  const { data, rows } = memData();
  rows.push({ feature_key: "o/r#esc", status: "running", pr_key: null, converge: 1, auto_merge: 1 });
  // A complete, answerable escalation → 1.
  await featureRuns(data).update("o/r#esc", {
    status: "escalated",
    escalation_user_task_key: "ut-9",
    escalation_question: "which base branch?",
  });
  assertEquals(rows[0].escalation_open, 1);
});

test("a torn escalation tuple projects escalation_open=0 (renders not-escalated, fail closed)", async () => {
  const { data, rows } = memData();
  // Simulate the exit-path/poller race: the question was cleared while status + pointer still lag in the
  // escalated projection (the mirror tear observed on nwf#270). The page must NOT show an escalation.
  rows.push({
    feature_key: "o/r#torn",
    status: "escalated",
    pr_key: null,
    converge: 1,
    auto_merge: 1,
    escalation_user_task_key: "ut-9",
    escalation_question: "which base?",
    escalation_open: 1,
  });
  await featureRuns(data).update("o/r#torn", { escalation_question: null });
  assertEquals(rows[0].escalation_open, 0);
});

test("clearing the escalation tuple flips escalation_open to 0 without waiting a poll pass", async () => {
  const { data, rows } = memData();
  // The answer operation eagerly clears pointer + question; the gateway reprojects on that same write,
  // so the affordance disappears immediately (issue #272 acceptance: no poll-pass lag).
  rows.push({
    feature_key: "o/r#ans",
    status: "escalated",
    pr_key: null,
    converge: 1,
    auto_merge: 1,
    escalation_user_task_key: "ut-9",
    escalation_question: "which base?",
    escalation_open: 1,
  });
  await featureRuns(data).update("o/r#ans", { escalation_user_task_key: null, escalation_question: null });
  assertEquals(rows[0].escalation_open, 0);
});

test("a run with converge=false projects stage_skipped containing Converging and Merging", async () => {
  const { data, rows } = memData();
  rows.push({ feature_key: "o/r#5", status: "running", converge: 0, auto_merge: 0 });
  await featureRuns(data).update("o/r#5", { status: "running" });
  assert(rows[0].stage_skipped.includes("Converging"));
  assert(rows[0].stage_skipped.includes("Merging"));
});

test("insert projects the pipeline columns from status", async () => {
  const { data, rows } = memData();
  await featureRuns(data).insert({ feature_key: "o/r#6", status: "running", converge: 1, auto_merge: 1 } as any);
  assertEquals(rows[0].stage, "Implementing");
  assertEquals(rows[0].stage_state, null);
  assertEquals(rows[0].list_bucket, "active");
});

test("setting acknowledged_at on a terminal row flips list_bucket to 'history'", async () => {
  const { data, rows } = memData();
  rows.push({ feature_key: "o/r#7", status: "merged", converge: 1, auto_merge: 1, acknowledged_at: null });
  // Terminal but unacknowledged → still Active.
  await featureRuns(data).update("o/r#7", { status: "merged" });
  assertEquals(rows[0].list_bucket, "active");
  // Acknowledge → History.
  await featureRuns(data).update("o/r#7", { acknowledged_at: "2024-01-01T00:00:00Z" });
  assertEquals(rows[0].list_bucket, "history");
  assertEquals(rows[0].stage, "Done");
});

test("update touching only projection-irrelevant fields skips the read-back and reproject", async () => {
  const { data, rows } = memData();
  rows.push({
    feature_key: "o/r#skip",
    status: "merged",
    converge: 1,
    auto_merge: 1,
    acknowledged_at: null,
    stage: "Done",
    stage_state: "ok",
    stage_skipped: "",
    attention: null,
    list_bucket: "active",
  });
  // Count get() calls to prove the projection-irrelevant path does no read-back roundtrip.
  let gets = 0;
  const raw = (data as any).table;
  (data as any).table = (n: string, pk?: string) => {
    const t = raw(n, pk);
    const origGet = t.get;
    t.get = async (id: any) => {
      gets++;
      return origGet.call(t, id);
    };
    return t;
  };
  await featureRuns(data).update("o/r#skip", { updated_at: "2024-06-01T00:00:00Z" });
  assertEquals(gets, 0);
  assertEquals(rows[0].updated_at, "2024-06-01T00:00:00Z");
  // Untouched projection stays as stored.
  assertEquals(rows[0].list_bucket, "active");

  // A projection-input change (acknowledged_at) DOES read back and reproject.
  await featureRuns(data).update("o/r#skip", { acknowledged_at: "2024-06-01T00:00:00Z" });
  assertEquals(gets, 1);
  assertEquals(rows[0].list_bucket, "history");
});

test("a direct write of a projection output field forces reprojection and overrides the raw value", async () => {
  const { data, rows } = memData();
  rows.push({
    feature_key: "o/r#bypass",
    status: "running",
    pr_key: null,
    converge: 1,
    auto_merge: 1,
    stage: "Implementing",
    stage_state: null,
    list_bucket: "active",
  });
  // A caller tries to bypass derivation by writing the derived column directly. The gateway must NOT
  // persist the raw value: it re-reads, recomputes from the merged inputs, and overrides it.
  await featureRuns(data).update("o/r#bypass", { stage: "Done", list_bucket: "history" });
  assertEquals(rows[0].stage, "Implementing");
  assertEquals(rows[0].list_bucket, "active");
});

test("backfillFeatureStages stamps legacy terminal and live rows with helper-derived values", async () => {
  const { data, rows } = memData();
  // Legacy rows written before migration 039 → projection columns absent/NULL.
  rows.push({ feature_key: "o/r#8", status: "merged", converge: 1, auto_merge: 1, acknowledged_at: "2024-01-01T00:00:00Z" });
  rows.push({ feature_key: "o/r#9", status: "running", pr_key: null, converge: 0, auto_merge: 0 });
  // A legacy row parked at a LIVE escalation when migration 040 lands: escalation_open is NULL and the
  // poller won't re-write it while it stays parked, so backfill MUST reproject it to 1 (issue #272).
  rows.push({ feature_key: "o/r#esc", status: "escalated", pr_key: null, converge: 1, auto_merge: 1, escalation_user_task_key: "ut-9", escalation_question: "which base?" });

  const stamped = await backfillFeatureStages(data);
  assertEquals(stamped, 3);

  const terminal = rows.find((r) => r.feature_key === "o/r#8");
  assertEquals(terminal.stage, "Done");
  assertEquals(terminal.stage_state, "ok");
  assertEquals(terminal.list_bucket, "history");

  const live = rows.find((r) => r.feature_key === "o/r#9");
  assertEquals(live.stage, "Implementing");
  assertEquals(live.stage_state, null);
  assertEquals(live.stage_skipped, "Converging Merging");
  assertEquals(live.list_bucket, "active");
  assertEquals(live.escalation_open, 0);

  const escalated = rows.find((r) => r.feature_key === "o/r#esc");
  assertEquals(escalated.escalation_open, 1);
});

test("backfillFeatureStages skips already-projected rows and counts only rows it stamps", async () => {
  const { data, rows } = memData();
  // One legacy row (no projection) + one already-projected row (gateway kept it fresh).
  rows.push({ feature_key: "o/r#legacy", status: "merged", converge: 1, auto_merge: 1, acknowledged_at: null });
  rows.push({ feature_key: "o/r#fresh", status: "merged", converge: 1, auto_merge: 1, acknowledged_at: null, stage: "Done", stage_state: "ok", stage_skipped: "", attention: null, list_bucket: "active", escalation_open: 0, updated_at: "0" });

  const stamped = await backfillFeatureStages(data);
  // Only the legacy row is stamped; the already-projected row is skipped.
  assertEquals(stamped, 1);
  const legacy = rows.find((r) => r.feature_key === "o/r#legacy");
  assertEquals(legacy.stage, "Done");
  assertEquals(legacy.escalation_open, 0);
  // The already-projected row was not re-written (its sentinel updated_at is untouched).
  const fresh = rows.find((r) => r.feature_key === "o/r#fresh");
  assertEquals(fresh.updated_at, "0");
});
