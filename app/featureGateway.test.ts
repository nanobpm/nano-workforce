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

test("backfillFeatureStages stamps legacy terminal and live rows with helper-derived values", async () => {
  const { data, rows } = memData();
  // Legacy rows written before migration 039 → projection columns absent/NULL.
  rows.push({ feature_key: "o/r#8", status: "merged", converge: 1, auto_merge: 1, acknowledged_at: "2024-01-01T00:00:00Z" });
  rows.push({ feature_key: "o/r#9", status: "running", pr_key: null, converge: 0, auto_merge: 0 });

  const stamped = await backfillFeatureStages(data);
  assertEquals(stamped, 2);

  const terminal = rows.find((r) => r.feature_key === "o/r#8");
  assertEquals(terminal.stage, "Done");
  assertEquals(terminal.stage_state, "ok");
  assertEquals(terminal.list_bucket, "history");

  const live = rows.find((r) => r.feature_key === "o/r#9");
  assertEquals(live.stage, "Implementing");
  assertEquals(live.stage_state, null);
  assertEquals(live.stage_skipped, "Converging Merging");
  assertEquals(live.list_bucket, "active");
});

test("backfillFeatureStages skips already-projected rows and counts only rows it stamps", async () => {
  const { data, rows } = memData();
  // One legacy row (no projection) + one already-projected row (gateway kept it fresh).
  rows.push({ feature_key: "o/r#legacy", status: "merged", converge: 1, auto_merge: 1, acknowledged_at: null });
  rows.push({ feature_key: "o/r#fresh", status: "merged", converge: 1, auto_merge: 1, acknowledged_at: null, stage: "Done", stage_state: "ok", stage_skipped: "", attention: null, list_bucket: "active", updated_at: "0" });

  const stamped = await backfillFeatureStages(data);
  // Only the legacy row is stamped; the already-projected row is skipped.
  assertEquals(stamped, 1);
  const legacy = rows.find((r) => r.feature_key === "o/r#legacy");
  assertEquals(legacy.stage, "Done");
  // The already-projected row was not re-written (its sentinel updated_at is untouched).
  const fresh = rows.find((r) => r.feature_key === "o/r#fresh");
  assertEquals(fresh.updated_at, "0");
});
