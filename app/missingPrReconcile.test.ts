// Issue #1089: a missing `pull_requests` row must not keep an epic or feature live forever. The
// reconciler looks the PR up on GitHub: merged/closed → a terminal row is written; absent past the
// grace period → the slice/feature is failed with a reason. Waiters then see a terminal state.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import { withTrackingViews } from "../test/trackingViews.ts";
import { deriveFeatureDelivery } from "./feature.ts";
import { derivePlanDelivery, MISSING_PR_GRACE_MS, type MissingPrLookup, reconcileMissingPrRows } from "./service.ts";

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
      async findOne(where: any = {}) {
        return rows.find((r) => match(r, where));
      },
      async insert(row: any) {
        rows.push({ ...row });
        return row[pk];
      },
      async update(id: any, patch: any) {
        const r = rows.find((row) => row[pk] === id);
        if (r) Object.assign(r, patch);
      },
      async delete() {},
    };
  }
  const data = { table: withTrackingViews((n: string, pk?: string) => tbl(n, pk)) } as any as DataLayer;
  return { data, stores };
}

const T0 = Date.parse("2026-01-01T00:00:00Z");
const ISO0 = new Date(T0).toISOString();
const lookupOf = (answer: MissingPrLookup) => async () => answer;

function seedEpic(stores: Record<string, any[]>, prKey: string) {
  stores.plans = [{ plan_key: "o/r#1", status: "done", created_at: ISO0, updated_at: ISO0 }];
  stores.plan_tasks = [{ id: 1, plan_key: "o/r#1", task_id: "a", pr_key: prKey, created_at: ISO0, updated_at: ISO0 }];
}

function seedFeature(stores: Record<string, any[]>, prKey: string) {
  stores.feature_runs = [
    { feature_key: "o/r#2", status: "converging", pr_key: prKey, converge: 1, delivery_label: "PR record missing", created_at: ISO0, updated_at: ISO0 },
  ];
}

test("epic: a slice PR merged on GitHub with no PR row → row written, epic delivery terminal", async () => {
  const { data, stores } = memData();
  seedEpic(stores, "o/r#10");
  const plan = stores.plans[0];
  assertEquals(await derivePlanDelivery(data, plan), "converging");
  await reconcileMissingPrRows(data, "", { lookup: lookupOf("merged"), nowMs: T0 + 1000 });
  assertEquals(stores.pull_requests?.[0]?.status, "merged");
  assertEquals(await derivePlanDelivery(data, plan), "landed");
});

test("feature: PR merged on GitHub with no PR row → row written, feature rolls up merged", async () => {
  const { data, stores } = memData();
  seedFeature(stores, "o/r#11");
  await reconcileMissingPrRows(data, "", { lookup: lookupOf("merged"), nowMs: T0 + 1000 });
  assertEquals(stores.pull_requests[0].status, "merged");
  assertEquals(deriveFeatureDelivery(stores.pull_requests[0].status).status, "merged");
});

test("closed on GitHub → abandoned row with reason (terminal)", async () => {
  const { data, stores } = memData();
  seedEpic(stores, "o/r#12");
  await reconcileMissingPrRows(data, "", { lookup: lookupOf("closed"), nowMs: T0 });
  assertEquals(stores.pull_requests[0].status, "abandoned");
  assertEquals(/closed on GitHub/.test(stores.pull_requests[0].outcome), true);
  assertEquals(await derivePlanDelivery(data, stores.plans[0]), null);
});

test("not found within grace → nothing written; open / unknown → nothing written", async () => {
  for (const answer of ["not_found", "open", null] as MissingPrLookup[]) {
    const { data, stores } = memData();
    seedEpic(stores, "o/r#13");
    seedFeature(stores, "o/r#14");
    const late = answer === "not_found" ? T0 + MISSING_PR_GRACE_MS - 1 : T0 + 10 * MISSING_PR_GRACE_MS;
    await reconcileMissingPrRows(data, "", { lookup: lookupOf(answer), nowMs: late });
    assertEquals(stores.pull_requests ?? [], []);
    assertEquals(stores.feature_runs[0].status, "converging");
  }
});

test("absent past grace → slice and feature failed with a reason", async () => {
  const { data, stores } = memData();
  seedEpic(stores, "o/r#15");
  seedFeature(stores, "o/r#16");
  await reconcileMissingPrRows(data, "", { lookup: lookupOf("not_found"), nowMs: T0 + MISSING_PR_GRACE_MS });
  const slice = stores.pull_requests.find((r: any) => r.pr_key === "o/r#15");
  assertEquals(slice.status, "abandoned");
  assertEquals(/not found on GitHub/.test(slice.outcome), true);
  assertEquals(await derivePlanDelivery(data, stores.plans[0]) !== "converging", true);
  assertEquals(stores.feature_runs[0].status, "failed");
  assertEquals(/not found on GitHub/.test(stores.feature_runs[0].delivery_label), true);
});
