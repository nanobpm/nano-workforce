// Read-model derivation test for the epic delivery signal (issue #171). `deriveDelivery` is the
// single source of truth for the denormalised `plans.delivery` / `plans.delivery_label` columns the
// poller projects. It must cleanly distinguish an epic whose fan-out is `done` but whose slices are
// still CONVERGING from one where every slice PR has LANDED, and count abandoned/converged PRs as
// resolved-not-landed (never `landed`).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import { deriveDelivery, TERMINAL_STATUSES } from "./delivery.ts";
import { pollDelivery } from "./service.ts";

// A tiny in-memory record gateway (all/find/update/insert), mirroring the fake-app style used
// across the app tests (see app/taskDelta.test.ts), enough to exercise the `pollDelivery` projection.
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

test("pollDelivery: a dangling pr_key (missing PR row) counts as in-flight, never false-landed", async () => {
  const { data, stores } = memData();
  stores.plans = [
    { plan_key: "epic-1", status: "done", delivery: null, delivery_label: null },
  ];
  stores.plan_tasks = [
    { id: 1, plan_key: "epic-1", pr_key: "o/r#1" },
    { id: 2, plan_key: "epic-1", pr_key: "o/r#2" }, // no matching pull_requests row (DB desync)
  ];
  stores.pull_requests = [{ pr_key: "o/r#1", status: "merged" }];

  await pollDelivery(data);

  // Without the dangling PR being treated as in-flight, this would wrongly become `landed` (1/1).
  assertEquals(stores.plans[0].delivery, "converging");
  assertEquals(stores.plans[0].delivery_label, "1/2 slices merged, 1 converging");
});

test("pollDelivery: all slice PR rows present and merged -> landed", async () => {
  const { data, stores } = memData();
  stores.plans = [
    { plan_key: "epic-2", status: "done", delivery: null, delivery_label: null },
  ];
  stores.plan_tasks = [
    { id: 1, plan_key: "epic-2", pr_key: "o/r#10" },
    { id: 2, plan_key: "epic-2", pr_key: "o/r#11" },
  ];
  stores.pull_requests = [
    { pr_key: "o/r#10", status: "merged" },
    { pr_key: "o/r#11", status: "merged" },
  ];

  await pollDelivery(data);

  assertEquals(stores.plans[0].delivery, "landed");
  assertEquals(stores.plans[0].delivery_label, "2/2 slices merged");
});

test("pollDelivery: a non-done plan is skipped and any stale projection is cleared", async () => {
  const { data, stores } = memData();
  stores.plans = [
    // Regressed out of `done` while carrying a stale `converging` projection.
    { plan_key: "epic-3", status: "in_progress", delivery: "converging", delivery_label: "1/2 slices merged, 1 converging" },
  ];
  // A task join here would be wasted work for a non-done plan; assert it is never consulted.
  let taskLookups = 0;
  stores.plan_tasks = [{ id: 1, plan_key: "epic-3", pr_key: "o/r#20" }];
  stores.pull_requests = [{ pr_key: "o/r#20", status: "merged" }];
  const origTable = (data as any).table.bind(data);
  (data as any).table = (n: string, pk?: string) => {
    const t = origTable(n, pk);
    if (n === "plan_tasks") {
      const origFind = t.find.bind(t);
      t.find = async (where: any) => {
        taskLookups++;
        return origFind(where);
      };
    }
    return t;
  };

  await pollDelivery(data);

  assertEquals(stores.plans[0].delivery, null);
  assertEquals(stores.plans[0].delivery_label, null);
  assertEquals(taskLookups, 0);
});
