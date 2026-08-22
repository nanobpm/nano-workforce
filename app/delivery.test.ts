// Read-model derivation test for the epic delivery signal (issue #171). `deriveDelivery` is the
// single source of truth the `plan_delivery` VIEW (061) encodes and the pollers derive at READ TIME
// (epic #412 retired the stored `plans.delivery` / `plans.delivery_label` columns). It must cleanly
// distinguish an epic whose fan-out is `done` but whose slices are still CONVERGING from one where
// every slice PR has LANDED, and count abandoned/converged PRs as resolved-not-landed (never
// `landed`). `pollPlanBucket` (app/service.ts) is the reader that applies the delivery-aware
// `list_bucket`/`ack_open` correction from that signal.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import { deriveDelivery, TERMINAL_STATUSES } from "./delivery.ts";
import { pollPlanBucket } from "./service.ts";

// A tiny in-memory record gateway (all/find/update/insert), mirroring the fake-app style used
// across the app tests (see app/taskDelta.test.ts), enough to exercise the `pollPlanBucket` pass.
function memData(): { data: DataLayer; stores: Record<string, any[]> } {
  const stores: Record<string, any[]> = {};
  function tbl(name: string, pk = "id") {
    const rows = (stores[name] ??= [] as any[]);
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
      },
    };
  }
  const data = { table: (n: string, pk?: string) => tbl(n, pk) } as any as DataLayer;
  return { data, stores };
}

test("all slice PRs merged -> landed", () => {
  const r = deriveDelivery("done", ["merged", "merged", "merged"]);
  assertEquals(r.delivery, "landed");
  assertEquals(r.prsOpened, 3);
  assertEquals(r.prsMerged, 3);
  assertEquals(r.prsInFlight, 0);
  assertEquals(r.label, "3/3 slices merged");
});

test("one slice PR still in flight -> converging", () => {
  const r = deriveDelivery("done", ["merged", "converging", "merged"]);
  assertEquals(r.delivery, "converging");
  assertEquals(r.prsOpened, 3);
  assertEquals(r.prsMerged, 2);
  assertEquals(r.prsInFlight, 1);
  assertEquals(r.label, "2/3 slices merged, 1 converging");
});

test("mixed merged/abandoned (all terminal, not all merged) -> resolved-not-landed (null)", () => {
  const r = deriveDelivery("done", ["merged", "abandoned", "merged"]);
  assertEquals(r.delivery, null);
  assertEquals(r.label, null);
  assertEquals(r.prsOpened, 3);
  assertEquals(r.prsMerged, 2);
  // abandoned is terminal, so it is NOT counted as in flight.
  assertEquals(r.prsInFlight, 0);
});

test("a converged (review-only, unmerged) slice keeps the epic out of landed", () => {
  // `converged` is terminal but not `merged`: resolved-not-landed, like abandoned.
  const r = deriveDelivery("done", ["merged", "converged"]);
  assertEquals(r.delivery, null);
  assertEquals(r.prsInFlight, 0);
  assertEquals(r.prsMerged, 1);
});

test("plan not yet done -> no delivery signal even with slice PRs", () => {
  for (const status of ["planning", "dispatched"]) {
    const r = deriveDelivery(status, ["merged", "converging"]);
    assertEquals(r.delivery, null, `status=${status}`);
    assertEquals(r.label, null, `status=${status}`);
  }
});

test("done but zero slice PRs -> no delivery signal", () => {
  const r = deriveDelivery("done", []);
  assertEquals(r.delivery, null);
  assertEquals(r.prsOpened, 0);
});

test("a single in-flight slice on a done plan is converging, not landed", () => {
  const r = deriveDelivery("done", ["waiting_review"]);
  assertEquals(r.delivery, "converging");
  assertEquals(r.label, "0/1 slices merged, 1 converging");
});

test("every non-terminal status counts as in flight", () => {
  const inFlight = ["converging", "waiting_review", "escalated", "queued", "open", "opened"];
  for (const s of inFlight) {
    assert(!TERMINAL_STATUSES.includes(s), `${s} must not be terminal`);
    const r = deriveDelivery("done", [s]);
    assertEquals(r.delivery, "converging", `status ${s}`);
    assertEquals(r.prsInFlight, 1, `status ${s}`);
  }
});

test("pollPlanBucket: a still-converging done epic suppresses the Dismiss flag (ack_open=0) and stays Active", async () => {
  const { data, stores } = memData();
  // A `done` epic the delivery-free gateway left as a Dismiss candidate (ack_open=1); pollPlanBucket
  // derives `converging` at read time and clears it.
  stores.plans = [
    { plan_key: "epic-1", status: "done", acknowledged_at: null, list_bucket: "active", ack_open: 1 },
  ];
  stores.plan_tasks = [
    { id: 1, plan_key: "epic-1", pr_key: "o/r#1" },
    { id: 2, plan_key: "epic-1", pr_key: "o/r#2" },
  ];
  stores.pull_requests = [
    { pr_key: "o/r#1", status: "merged" },
    { pr_key: "o/r#2", status: "converging" },
  ];

  await pollPlanBucket(data);

  assertEquals(stores.plans[0].list_bucket, "active");
  assertEquals(stores.plans[0].ack_open, 0, "converging epic must not offer Dismiss");
});

test("pollPlanBucket: a fully landed done epic opens the Dismiss flag (ack_open=1), still Active", async () => {
  const { data, stores } = memData();
  stores.plans = [
    { plan_key: "epic-2", status: "done", acknowledged_at: null, list_bucket: "active", ack_open: 0 },
  ];
  stores.plan_tasks = [
    { id: 1, plan_key: "epic-2", pr_key: "o/r#10" },
    { id: 2, plan_key: "epic-2", pr_key: "o/r#11" },
  ];
  stores.pull_requests = [
    { pr_key: "o/r#10", status: "merged" },
    { pr_key: "o/r#11", status: "merged" },
  ];

  await pollPlanBucket(data);

  assertEquals(stores.plans[0].list_bucket, "active");
  assertEquals(stores.plans[0].ack_open, 1);
});

test("pollPlanBucket: a dangling pr_key keeps the epic converging (ack_open stays 0)", async () => {
  const { data, stores } = memData();
  stores.plans = [
    { plan_key: "epic-3", status: "done", acknowledged_at: null, list_bucket: "active", ack_open: 1 },
  ];
  stores.plan_tasks = [
    { id: 1, plan_key: "epic-3", pr_key: "o/r#1" },
    { id: 2, plan_key: "epic-3", pr_key: "o/r#2" }, // no matching pull_requests row (DB desync)
  ];
  stores.pull_requests = [{ pr_key: "o/r#1", status: "merged" }];

  await pollPlanBucket(data);

  // Without the dangling PR counting as in-flight this would wrongly land → open Dismiss.
  assertEquals(stores.plans[0].ack_open, 0);
});

test("pollPlanBucket: an acknowledged landed epic buckets to History", async () => {
  const { data, stores } = memData();
  stores.plans = [
    {
      plan_key: "epic-4",
      status: "done",
      acknowledged_at: "2024-01-01T00:00:00Z",
      list_bucket: "active",
      ack_open: 1,
    },
  ];
  stores.plan_tasks = [{ id: 1, plan_key: "epic-4", pr_key: "o/r#20" }];
  stores.pull_requests = [{ pr_key: "o/r#20", status: "merged" }];

  await pollPlanBucket(data);

  assertEquals(stores.plans[0].list_bucket, "history");
  assertEquals(stores.plans[0].ack_open, 0);
});

test("pollPlanBucket: a steady-state pass rewrites nothing (idempotent)", async () => {
  const { data, stores } = memData();
  stores.plans = [
    {
      plan_key: "epic-5",
      status: "done",
      acknowledged_at: null,
      list_bucket: "active",
      ack_open: 1,
      updated_at: "2020-01-01T00:00:00.000Z",
    },
  ];
  stores.plan_tasks = [{ id: 1, plan_key: "epic-5", pr_key: "o/r#30" }];
  stores.pull_requests = [{ pr_key: "o/r#30", status: "merged" }]; // landed → ack_open already 1

  await pollPlanBucket(data);

  assertEquals(stores.plans[0].updated_at, "2020-01-01T00:00:00.000Z", "no-op pass must not re-stamp");
});
