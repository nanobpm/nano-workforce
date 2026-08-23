// Read-model derivation test for the FEATURE-run delivery reconcile (fix: Feature history stuck at
// `converging`). A single-issue feature run hands its opened PR to the convergence loop and ENDS with
// `feature_runs.status = 'converging'`; the PR's live outcome then lives only on `pull_requests`
// (keyed by `pr_key`). `deriveFeatureDelivery` is the pure source of truth for the status transition
// + `delivery_label` that `pollFeatureDelivery` projects onto the row so the grid stops looking frozen.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import { withTrackingViews } from "../test/trackingViews.ts";
import { deriveFeatureDelivery } from "./feature.ts";
import { pollFeatureDelivery } from "./service.ts";

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
  const data = { table: withTrackingViews((n: string, pk?: string) => tbl(n, pk)) } as any as DataLayer;
  return { data, stores };
}

test("deriveFeatureDelivery: merged PR advances the run to merged", () => {
  assertEquals(deriveFeatureDelivery("merged"), { status: "merged", label: "merged" });
});

test("deriveFeatureDelivery: converged (review-only, unmerged) PR advances to converged", () => {
  assertEquals(deriveFeatureDelivery("converged"), { status: "converged", label: "converged (not merged)" });
});

test("deriveFeatureDelivery: abandoned PR advances to abandoned", () => {
  assertEquals(deriveFeatureDelivery("abandoned"), { status: "abandoned", label: "PR abandoned" });
});

test("deriveFeatureDelivery: an in-flight PR keeps the run converging, surfacing the sub-state", () => {
  for (const s of ["converging", "waiting_review", "escalated"]) {
    assertEquals(deriveFeatureDelivery(s), { status: "converging", label: s }, `status ${s}`);
  }
});

test("deriveFeatureDelivery: a missing PR row keeps converging, never a false-positive terminal", () => {
  assertEquals(deriveFeatureDelivery(null), { status: "converging", label: "PR record missing" });
});

test("pollFeatureDelivery: a converging run whose PR merged is reconciled to merged", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#1", status: "converging", pr_key: "o/r#5", delivery_label: null },
  ];
  stores.pull_requests = [{ pr_key: "o/r#5", status: "merged" }];

  await pollFeatureDelivery(data);

  assertEquals(stores.feature_runs[0].status, "merged");
  assertEquals(stores.feature_runs[0].delivery_label, "merged");
});

test("pollFeatureDelivery: a run with a still-in-flight PR stays converging with a live label", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#2", status: "converging", pr_key: "o/r#6", delivery_label: null },
  ];
  stores.pull_requests = [{ pr_key: "o/r#6", status: "waiting_review" }];

  await pollFeatureDelivery(data);

  assertEquals(stores.feature_runs[0].status, "converging");
  assertEquals(stores.feature_runs[0].delivery_label, "waiting_review");
});

test("pollFeatureDelivery: only touches converging runs with a pr_key", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#3", status: "opened", pr_key: null, delivery_label: null }, // not converging
    { feature_key: "o/r#4", status: "converging", pr_key: null, delivery_label: null }, // no PR to read
    { feature_key: "o/r#5", status: "blocked", pr_key: "o/r#9", delivery_label: null }, // terminal, not converging
  ];
  stores.pull_requests = [{ pr_key: "o/r#9", status: "merged" }];

  await pollFeatureDelivery(data);

  assertEquals(stores.feature_runs[0].status, "opened");
  assertEquals(stores.feature_runs[1].status, "converging");
  assertEquals(stores.feature_runs[1].delivery_label, null);
  assertEquals(stores.feature_runs[2].status, "blocked");
});

test("pollFeatureDelivery: a dangling pr_key (missing PR row) stays converging, never a false terminal", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#6", status: "converging", pr_key: "o/r#404", delivery_label: null },
  ];
  stores.pull_requests = [];

  await pollFeatureDelivery(data);

  assertEquals(stores.feature_runs[0].status, "converging");
  assertEquals(stores.feature_runs[0].delivery_label, "PR record missing");
});
