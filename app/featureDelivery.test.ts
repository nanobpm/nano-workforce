// Read-model derivation test for the FEATURE-run delivery reconcile (fix: Feature history stuck at
// `converging`). A single-issue feature run hands its opened PR to the convergence loop and ENDS with
// `feature_runs.status = 'converging'`; the PR's live outcome then lives only on `pull_requests`
// (keyed by `pr_key`). `deriveFeatureDelivery` is the pure source of truth for the status transition
// + `delivery_label` that `pollFeatureDelivery` projects onto the row so the grid stops looking frozen.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import { withTrackingViews } from "../test/trackingViews.ts";
import { deriveFeatureCompletion, deriveFeatureDelivery, foldCompletedFeatureRun } from "./feature.ts";
import { pollFeatureDelivery } from "./service.ts";

// An engine stub for the CONVERGING-reconcile tests (edge 1), which seed no `running` runs — the
// COMPLETED→terminal fold (edge 2, issue #808) therefore reads no instance. The completion-fold tests
// below pass their own state-returning stub.
const STUB_ENGINE = { searchProcessInstances: async () => [] as any[] } as any;

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
  // Minimal `open().exec()` for the ONE guarded CAS the COMPLETED fold issues (foldCompletedFeatureRun).
  // It mutates the in-memory `feature_runs` store exactly as the SQLite guard would, so the race test
  // below exercises the real CAS predicate (same feature_key + process_key + status='running').
  (data as any).open = () => ({
    async exec(sql: string, params: any[]) {
      if (!/UPDATE "feature_runs" SET .* WHERE "feature_key" = \? AND "process_key" = \? AND "status" = 'running'/.test(sql)) {
        throw new Error(`memData mock: unhandled sql: ${sql}`);
      }
      const [status, label, updated_at, feature_key, process_key] = params;
      const rows = stores.feature_runs ?? [];
      let changed = 0;
      for (const r of rows) {
        if (r.feature_key === feature_key && r.process_key === process_key && r.status === "running") {
          Object.assign(r, { status, delivery_label: label, updated_at });
          changed++;
        }
      }
      return { changed };
    },
  });
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

  await pollFeatureDelivery(data, STUB_ENGINE);

  assertEquals(stores.feature_runs[0].status, "merged");
  assertEquals(stores.feature_runs[0].delivery_label, "merged");
});

test("pollFeatureDelivery: a run with a still-in-flight PR stays converging with a live label", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#2", status: "converging", pr_key: "o/r#6", delivery_label: null },
  ];
  stores.pull_requests = [{ pr_key: "o/r#6", status: "waiting_review" }];

  await pollFeatureDelivery(data, STUB_ENGINE);

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

  await pollFeatureDelivery(data, STUB_ENGINE);

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

  await pollFeatureDelivery(data, STUB_ENGINE);

  assertEquals(stores.feature_runs[0].status, "converging");
  assertEquals(stores.feature_runs[0].delivery_label, "PR record missing");
});

// ── Edge 2: COMPLETED → terminal fold for a normally-completing `running` run (issue #808) ─────────

test("deriveFeatureCompletion: a run that raised a PR folds to opened", () => {
  assertEquals(deriveFeatureCompletion({ pr_key: "o/r#5" }), { status: "opened", label: "PR raised" });
});

test("deriveFeatureCompletion: a run that raised no PR folds to skipped", () => {
  assertEquals(deriveFeatureCompletion({ pr_key: null }), { status: "skipped", label: "nothing to do" });
});

test("pollFeatureDelivery: a raise-only running run whose engine instance is COMPLETED folds to opened (issue #808)", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#7", status: "running", process_key: "pi-7", pr_key: "o/r#5", converge: 0, delivery_label: null },
  ];
  stores.pull_requests = [];
  const engine = { searchProcessInstances: async () => [{ processInstanceKey: "pi-7", state: "COMPLETED" }] } as any;

  await pollFeatureDelivery(data, engine);

  // Red before the fix: it stays wedged at `running` in the Active bucket.
  assertEquals(stores.feature_runs[0].status, "opened");
  assertEquals(stores.feature_runs[0].delivery_label, "PR raised");
});

test("pollFeatureDelivery: a nothing-to-do running run whose instance is COMPLETED folds to skipped (issue #808)", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#8", status: "running", process_key: "pi-8", pr_key: null, converge: 0, delivery_label: null },
  ];
  stores.pull_requests = [];
  const engine = { searchProcessInstances: async () => [{ processInstanceKey: "pi-8", state: "COMPLETED" }] } as any;

  await pollFeatureDelivery(data, engine);

  assertEquals(stores.feature_runs[0].status, "skipped");
  assertEquals(stores.feature_runs[0].delivery_label, "nothing to do");
});

test("pollFeatureDelivery: a running run whose instance is STILL ACTIVE is left untouched (idempotent)", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#9", status: "running", process_key: "pi-9", pr_key: "o/r#5", converge: 0, delivery_label: null },
  ];
  stores.pull_requests = [];
  const engine = { searchProcessInstances: async () => [{ processInstanceKey: "pi-9", state: "ACTIVE" }] } as any;

  await pollFeatureDelivery(data, engine);

  assertEquals(stores.feature_runs[0].status, "running");
  assertEquals(stores.feature_runs[0].delivery_label, null);
});

test("pollFeatureDelivery: a running run TERMINATED out of band (derived abandoned) is left to onTerminated, never re-queried (issue #808)", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#10", status: "running", process_key: "pi-10", pr_key: "o/r#5", converge: 0, delivery_label: null, derived_status: "abandoned" },
  ];
  stores.pull_requests = [];
  let queried = false;
  const engine = { searchProcessInstances: async () => { queried = true; return []; } } as any;

  await pollFeatureDelivery(data, engine);

  assertEquals(queried, false);
  assertEquals(stores.feature_runs[0].status, "running");
});

test("pollFeatureDelivery: never touches a CONVERGING run in the COMPLETED fold — that edge stays owned by the converging reconcile (issue #808)", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#11", status: "converging", process_key: "pi-11", pr_key: "o/r#5", converge: 1, delivery_label: null },
  ];
  stores.pull_requests = [{ pr_key: "o/r#5", status: "waiting_review" }];
  let queried = false;
  const engine = { searchProcessInstances: async () => { queried = true; return [{ processInstanceKey: "pi-11", state: "COMPLETED" }]; } } as any;

  await pollFeatureDelivery(data, engine);

  // The COMPLETED fold is scoped to `running`, so it never reads the engine for a converging run;
  // the converging reconcile above keeps it converging while its PR is in flight.
  assertEquals(queried, false);
  assertEquals(stores.feature_runs[0].status, "converging");
  assertEquals(stores.feature_runs[0].delivery_label, "waiting_review");
});

test("pollFeatureDelivery: a re-seed race (new process_key) between the engine read and the write is a no-op — the guard never clobbers the fresh incarnation (issue #808)", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#12", status: "running", process_key: "pi-12-old", pr_key: "o/r#5", converge: 0, delivery_label: null },
  ];
  stores.pull_requests = [];
  // The engine read reports the OLD instance COMPLETED, but `startFeature` re-seeds the SAME row to a
  // fresh `running` incarnation (new process_key) in the window before the write — modelled by mutating
  // the store from inside the awaited stub. A blind update-by-key would fold this live run to opened.
  const engine = {
    searchProcessInstances: async () => {
      const row = stores.feature_runs[0];
      row.process_key = "pi-12-new";
      row.pr_key = null;
      return [{ processInstanceKey: "pi-12-old", state: "COMPLETED" }];
    },
  } as any;

  await pollFeatureDelivery(data, engine);

  // The guarded CAS matched zero rows (process_key drifted), so the fresh incarnation is untouched.
  assertEquals(stores.feature_runs[0].status, "running");
  assertEquals(stores.feature_runs[0].process_key, "pi-12-new");
  assertEquals(stores.feature_runs[0].delivery_label, null);
});

test("foldCompletedFeatureRun: guarded CAS flips a matching running row and is a no-op on a process_key mismatch (issue #808)", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#13", status: "running", process_key: "pi-13", pr_key: null, delivery_label: null },
  ];

  // Matching (feature_key + process_key + status='running') → flips.
  assertEquals(await foldCompletedFeatureRun(data, "o/r#13", "pi-13", "opened", "PR raised"), true);
  assertEquals(stores.feature_runs[0].status, "opened");
  assertEquals(stores.feature_runs[0].delivery_label, "PR raised");

  // A stale process_key (a re-seed already flipped the row back to running under a new key) → no-op.
  stores.feature_runs[0].status = "running";
  stores.feature_runs[0].process_key = "pi-13-new";
  assertEquals(await foldCompletedFeatureRun(data, "o/r#13", "pi-13", "skipped", "nothing to do"), false);
  assertEquals(stores.feature_runs[0].status, "running");
});
