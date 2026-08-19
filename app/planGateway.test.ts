// Tests for the `plans` gateway's write-time epic-bucket projection (issue #298) and its one-shot
// backfill. The gateway wraps the plain table so EVERY writer — startPlan, the record workers, the
// delivery poller, the acknowledge-epic op — automatically gets a fresh `list_bucket`/`ack_open`
// projection without passing them: the single write path is the only place `deriveEpicBucket` /
// `epicIsAcknowledgeable` are applied. Mirrors app/featureGateway.test.ts.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import { backfillPlanBuckets, plans } from "./plan.ts";

// In-memory record gateway with the same semantics the real Table exposes. The `plans` proxy wraps
// whatever data.table returns, so this exercises the real proxy.
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

test("insert projects list_bucket/ack_open from status without the caller passing them", async () => {
  const { data, rows } = memData();
  await plans(data).insert({ plan_key: "o/r#1", status: "planning" });
  assertEquals(rows[0].list_bucket, "active");
  assertEquals(rows[0].ack_open, 0);
});

test("status flip to done+converging keeps the epic Active (no vanish)", async () => {
  const { data, rows } = memData();
  rows.push({ plan_key: "o/r#2", status: "dispatched", delivery: null });
  // record-results marks the epic done; the delivery poller then sets converging.
  await plans(data).update("o/r#2", { status: "done" });
  assertEquals(rows[0].list_bucket, "active");
  await plans(data).update("o/r#2", { delivery: "converging", delivery_label: "1/2 slices merged, 1 converging" });
  assertEquals(rows[0].list_bucket, "active");
  assertEquals(rows[0].ack_open, 0);
});

test("delivery landing opens the Dismiss affordance (ack_open=1) but keeps it Active until acknowledged", async () => {
  const { data, rows } = memData();
  rows.push({ plan_key: "o/r#3", status: "done", delivery: "converging" });
  await plans(data).update("o/r#3", { delivery: "landed", delivery_label: "2/2 slices merged" });
  assertEquals(rows[0].list_bucket, "active");
  assertEquals(rows[0].ack_open, 1);
  // Operator dismisses → gateway reprojects to History, ack_open closes.
  await plans(data).update("o/r#3", { acknowledged_at: "2024-01-01T00:00:00Z" });
  assertEquals(rows[0].list_bucket, "history");
  assertEquals(rows[0].ack_open, 0);
});

test("a projection-irrelevant patch (wave_label only) does not disturb the stored bucket", async () => {
  const { data, rows } = memData();
  rows.push({ plan_key: "o/r#4", status: "done", delivery: "landed", list_bucket: "active", ack_open: 1 });
  await plans(data).update("o/r#4", { wave_label: "2/2" });
  assertEquals(rows[0].list_bucket, "active");
  assertEquals(rows[0].ack_open, 1);
});

test("a direct write to list_bucket is overridden by the canonical derivation (no bypass)", async () => {
  const { data, rows } = memData();
  rows.push({ plan_key: "o/r#5", status: "done", delivery: "converging" });
  // A caller tries to force History; the gateway re-derives from status+delivery and overrides it.
  await plans(data).update("o/r#5", { list_bucket: "history" });
  assertEquals(rows[0].list_bucket, "active");
});

test("backfillPlanBuckets stamps only legacy (NULL list_bucket) rows, idempotently", async () => {
  const { data, rows } = memData();
  rows.push({ plan_key: "o/r#legacy", status: "done", delivery: "converging", list_bucket: null, ack_open: null });
  rows.push({ plan_key: "o/r#fresh", status: "planning", list_bucket: "active", ack_open: 0 });
  const stamped = await backfillPlanBuckets(data);
  assertEquals(stamped, 1);
  assertEquals(rows[0].list_bucket, "active");
  assertEquals(rows[0].ack_open, 0);
  // Second pass is a no-op: every row is now projected.
  assertEquals(await backfillPlanBuckets(data), 0);
});

test("terminal failed epic buckets to History", async () => {
  const { data, rows } = memData();
  rows.push({ plan_key: "o/r#6", status: "dispatched" });
  await plans(data).update("o/r#6", { status: "failed" });
  assertEquals(rows[0].list_bucket, "history");
  assert(!rows[0].ack_open);
});
