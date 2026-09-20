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

// Pin the GitHub transport to `token` with an EMPTY token so the edge (1) re-enroll tests — which now
// reach the real `submitPr` for a converging run whose PR row is missing (PR #809 review) — never shell
// out to `gh`/`fetch`: `fetchPrMeta` short-circuits to `null` (best-effort), keeping the tests hermetic.
const PRIOR_TRANSPORT = process.env["NANO_PR_GITHUB_TRANSPORT"];
const PRIOR_TOKEN = process.env["GITHUB_TOKEN"];
process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
process.env["GITHUB_TOKEN"] = "";
process.on("exit", () => {
  if (PRIOR_TRANSPORT === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
  else process.env["NANO_PR_GITHUB_TRANSPORT"] = PRIOR_TRANSPORT;
  if (PRIOR_TOKEN === undefined) delete process.env["GITHUB_TOKEN"];
  else process.env["GITHUB_TOKEN"] = PRIOR_TOKEN;
});

// An engine stub for the CONVERGING-reconcile tests (edge 1), which seed no `running` runs — the
// COMPLETED→terminal fold (edge 2, issue #808) therefore reads no instance. The completion-fold tests
// below pass their own state-returning stub. `createInstance` records the re-enroll (edge 1, PR #809)
// and returns a fresh instance key so `submitPr` completes; `searchProcessInstances` stays empty.
const STUB_ENGINE = {
  searchProcessInstances: async () => [] as any[],
  createInstance: async () => ({ processInstanceKey: "pi-reenroll" }),
} as any;

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
      async delete(id: any) {
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i][pk] === id) rows.splice(i, 1);
      },
    };
  }
  const data = { table: withTrackingViews((n: string, pk?: string) => tbl(n, pk)) } as any as DataLayer;
  // Minimal `open().exec()` for the guarded CAS folds (foldCompletedFeatureRun — the COMPLETED
  // running→terminal fold AND the mid-handoff opened→abandoned reconcile). It mutates the in-memory
  // `feature_runs` store exactly as the SQLite guard would, so the race/handoff tests exercise the real
  // CAS predicate (same feature_key + process_key + status = the observed transient, now a bound param).
  (data as any).open = () => ({
    async exec(sql: string, params: any[]) {
      if (!/UPDATE "feature_runs" SET .* WHERE "feature_key" = \? AND "process_key" = \? AND "status" = \?/.test(sql)) {
        throw new Error(`memData mock: unhandled sql: ${sql}`);
      }
      const [status, label, updated_at, feature_key, process_key, expect_status] = params;
      const rows = stores.feature_runs ?? [];
      let changed = 0;
      for (const r of rows) {
        if (r.feature_key === feature_key && r.process_key === process_key && r.status === expect_status) {
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

test("pollFeatureDelivery: a converging run whose PR row is MISSING is re-enrolled (idempotent) and stays converging, never a false terminal (PR #809)", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#6", status: "converging", pr_key: "o/r#404", auto_merge: 0, delivery_label: null },
  ];
  stores.pull_requests = [];
  let created = 0;
  const engine = {
    searchProcessInstances: async () => [],
    createInstance: async () => {
      created++;
      return { processInstanceKey: "pi-404" };
    },
  } as any;

  await pollFeatureDelivery(data, engine);

  // `converge-feature` now writes `converging` BEFORE `submitPr`, so a crash in that gap leaves a
  // converging row with no enrolled PR. Edge (1) heals it by RE-ENROLLING via `submitPr` (which starts
  // a fresh convergence instance) rather than wedging it forever at "PR record missing".
  assertEquals(created, 1, "the missing-PR converging run is re-enrolled via submitPr");
  assertEquals(stores.pull_requests.length, 1, "submitPr registered the pull_requests row");
  assertEquals(stores.pull_requests[0].pr_key, "o/r#404");
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

// ── Edge 3: MID-HANDOFF `opened` → abandoned when the instance died before convergence (PR #809) ────
//
// `record-feature` writes base `status="opened"` for a converge-REQUESTED run too, BEFORE `gw-converge`
// hands it to `converge-feature` (which flips it to `converging`). That transient `opened` + `converge=1`
// + `pr_key` window is NOT dismissable (featureReadModel excludes it), and no other edge / instanceTracking
// activeStatus scans it — so an instance TERMINATED mid-handoff would strand the row in Active forever.
// This edge owns that liveness.

test("pollFeatureDelivery: a mid-handoff opened run whose instance TERMINATED (gone) folds to abandoned (PR #809)", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#20", status: "opened", process_key: "pi-20", pr_key: "o/r#5", converge: 1, delivery_label: null },
  ];
  stores.pull_requests = [];
  // The instance is gone (terminated + reaped) → searchProcessInstances returns no snapshot.
  const engine = { searchProcessInstances: async () => [] } as any;

  await pollFeatureDelivery(data, engine);

  // Red before the fix: it stays wedged at `opened` (non-dismissable, unowned) in the Active bucket.
  assertEquals(stores.feature_runs[0].status, "abandoned");
  assertEquals(stores.feature_runs[0].delivery_label, "handoff interrupted");
});

test("pollFeatureDelivery: a mid-handoff opened run whose instance read TERMINATED folds to abandoned (PR #809)", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#21", status: "opened", process_key: "pi-21", pr_key: "o/r#5", converge: 1, delivery_label: null },
  ];
  stores.pull_requests = [];
  const engine = { searchProcessInstances: async () => [{ processInstanceKey: "pi-21", state: "TERMINATED" }] } as any;

  await pollFeatureDelivery(data, engine);

  assertEquals(stores.feature_runs[0].status, "abandoned");
  assertEquals(stores.feature_runs[0].delivery_label, "handoff interrupted");
});

test("pollFeatureDelivery: a mid-handoff opened run whose instance is STILL ACTIVE is left for converge-feature (PR #809)", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#22", status: "opened", process_key: "pi-22", pr_key: "o/r#5", converge: 1, delivery_label: null },
  ];
  stores.pull_requests = [];
  const engine = { searchProcessInstances: async () => [{ processInstanceKey: "pi-22", state: "ACTIVE" }] } as any;

  await pollFeatureDelivery(data, engine);

  assertEquals(stores.feature_runs[0].status, "opened");
  assertEquals(stores.feature_runs[0].delivery_label, null);
});

test("pollFeatureDelivery: a FINISHED raise-only opened run (converge=0) is never queried by the handoff edge (PR #809)", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#23", status: "opened", process_key: "pi-23", pr_key: "o/r#5", converge: 0, delivery_label: null },
  ];
  stores.pull_requests = [];
  let queried = false;
  const engine = { searchProcessInstances: async () => { queried = true; return []; } } as any;

  await pollFeatureDelivery(data, engine);

  // A raise-only opened is genuinely terminal + dismissable — the handoff edge must not touch it.
  assertEquals(queried, false);
  assertEquals(stores.feature_runs[0].status, "opened");
});

test("pollFeatureDelivery: a keyless opened run (pr_key null) is never queried by the handoff edge (PR #809)", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#24", status: "opened", process_key: "pi-24", pr_key: null, converge: 1, delivery_label: null },
  ];
  stores.pull_requests = [];
  let queried = false;
  const engine = { searchProcessInstances: async () => { queried = true; return []; } } as any;

  await pollFeatureDelivery(data, engine);

  // A keyless opened never satisfied the gateway's prKey!=null and fell through to End — terminal.
  assertEquals(queried, false);
  assertEquals(stores.feature_runs[0].status, "opened");
});

test("pollFeatureDelivery: a mid-handoff opened run already folded abandoned out of band is not re-queried (PR #809)", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#25", status: "opened", process_key: "pi-25", pr_key: "o/r#5", converge: 1, delivery_label: null, derived_status: "abandoned" },
  ];
  stores.pull_requests = [];
  let queried = false;
  const engine = { searchProcessInstances: async () => { queried = true; return []; } } as any;

  await pollFeatureDelivery(data, engine);

  assertEquals(queried, false);
  assertEquals(stores.feature_runs[0].status, "opened");
});

test("pollFeatureDelivery: a mid-handoff opened run whose instance read a KNOWN terminal (COMPLETED) folds to abandoned (PR #809 review, thread 3)", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#26", status: "opened", process_key: "pi-26", pr_key: "o/r#5", converge: 1, delivery_label: null },
  ];
  stores.pull_requests = [];
  // COMPLETED is a KNOWN terminal (ENGINE_TERMINAL_STATES) — a positive "the instance is gone", so a
  // still-`opened` mid-handoff row is a genuinely interrupted handoff and folds to abandoned.
  const engine = { searchProcessInstances: async () => [{ processInstanceKey: "pi-26", state: "COMPLETED" }] } as any;

  await pollFeatureDelivery(data, engine);

  assertEquals(stores.feature_runs[0].status, "abandoned");
  assertEquals(stores.feature_runs[0].delivery_label, "handoff interrupted");
});

test("RED/GREEN pollFeatureDelivery: a mid-handoff opened run whose PR row EXISTS (enrolled) folds to converging, NEVER abandoned, even when the instance TERMINATED (PR #809 review / escalation 162)", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#30", status: "opened", process_key: "pi-30", pr_key: "o/r#5", converge: 1, delivery_label: null },
  ];
  // `converge-feature` already enrolled the PR (a `pull_requests` row EXISTS), then the FEATURE instance
  // terminated mid-handoff before flipping the row to `converging`. The PR is a live/settled SEPARATE
  // process — the handoff was NOT interrupted.
  stores.pull_requests = [{ pr_key: "o/r#5", status: "converging" }];
  // Instance gone AND read as a KNOWN terminal — either signal would drive the OLD instance-only edge to
  // `abandoned`. The PR-first rule must override both.
  const engine = { searchProcessInstances: async () => [{ processInstanceKey: "pi-30", state: "TERMINATED" }] } as any;

  await pollFeatureDelivery(data, engine);

  // Red before the fix (instance-only edge): folds an ENROLLED, live PR to `abandoned`, losing its outcome.
  assertEquals(stores.feature_runs[0].status, "converging", "an enrolled PR is projected, never abandoned");
  assertEquals(stores.feature_runs[0].delivery_label, "converging");
});

test("pollFeatureDelivery: a mid-handoff opened run whose enrolled PR already MERGED projects the terminal outcome (merged), not abandoned (PR #809 review / escalation 162)", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#31", status: "opened", process_key: "pi-31", pr_key: "o/r#5", converge: 1, delivery_label: null },
  ];
  stores.pull_requests = [{ pr_key: "o/r#5", status: "merged" }];
  let queried = false;
  // The PR row settles the liveness question — the handoff edge must not even probe the engine.
  const engine = { searchProcessInstances: async () => { queried = true; return []; } } as any;

  await pollFeatureDelivery(data, engine);

  assertEquals(queried, false, "an existing PR row is authoritative — no engine probe needed");
  assertEquals(stores.feature_runs[0].status, "merged");
  assertEquals(stores.feature_runs[0].delivery_label, "merged");
});

test("RED/GREEN pollFeatureDelivery: a mid-handoff opened run whose instance snapshot carries an EMPTY/UNKNOWN state is SPARED, never folded (PR #809 review, thread 3)", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#28", status: "opened", process_key: "pi-28", pr_key: "o/r#5", converge: 1, delivery_label: null },
    { feature_key: "o/r#29", status: "opened", process_key: "pi-29", pr_key: "o/r#5", converge: 1, delivery_label: null },
  ];
  stores.pull_requests = [];
  // The engine ANSWERED (the instance is present) but with an empty / newly-introduced state we cannot
  // interpret — a partial read, NOT a confirmed death. The reconcile-probe tri-state spares such a row;
  // folding it to `abandoned` would kill a possibly still-live handoff off a wire shape we misread.
  const engine = {
    searchProcessInstances: async ({ processInstanceKeys }: any) => {
      const key = String(processInstanceKeys[0]);
      return [{ processInstanceKey: key, state: key === "pi-28" ? "" : "SUSPENDED_NOVEL_STATE" }];
    },
  } as any;

  await pollFeatureDelivery(data, engine);

  // Red before the fix (`state !== "ACTIVE"` folded everything non-ACTIVE): both rows would go abandoned.
  assertEquals(stores.feature_runs[0].status, "opened", "an empty engine state spares the row");
  assertEquals(stores.feature_runs[0].delivery_label, null);
  assertEquals(stores.feature_runs[1].status, "opened", "an unrecognised engine state spares the row");
  assertEquals(stores.feature_runs[1].delivery_label, null);
});

test("RED/GREEN pollFeatureDelivery: a running run edge (2) folds to `opened` in a pass is NOT re-folded to abandoned by the handoff edge in the SAME pass (PR #809 review, thread 1)", async () => {
  const { data, stores } = memData();
  // A `running` run carrying converge=1 + pr_key whose instance COMPLETED: edge (2) folds it running→
  // `opened` (PR raised). Edge (3) then re-reads the DB, sees that just-folded `opened`+converge=1+pr_key
  // row with a non-ACTIVE (COMPLETED) instance, and — without the same-pass exclusion — would clobber
  // edge (2)'s legitimate terminal to `abandoned`.
  stores.feature_runs = [
    { feature_key: "o/r#27", status: "running", process_key: "pi-27", pr_key: "o/r#5", converge: 1, delivery_label: null },
  ];
  stores.pull_requests = [];
  const engine = { searchProcessInstances: async () => [{ processInstanceKey: "pi-27", state: "COMPLETED" }] } as any;

  await pollFeatureDelivery(data, engine);

  assertEquals(stores.feature_runs[0].status, "opened", "edge (2)'s terminal outcome stands — the same-pass handoff edge leaves it alone");
  assertEquals(stores.feature_runs[0].delivery_label, "PR raised");
});
