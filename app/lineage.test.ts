// Read-model derivation test for the lineage projection (issue #245). `deriveLineage` is the single
// source of truth for the denormalised `lineage_threads` rows the poller projects: it must stitch a
// request → implementation → PR(s) → convergence → merge → outcome arc into one thread, expose the
// active frontier plus whether the arc has settled, roll epic fan-out up across N slice PRs, and
// tolerate a human/webhook PR with no originating request (self-rooted, kind `pr`).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import {
  deriveLineage,
  type LineagePr,
  type LineageThreadRow,
  listLineage,
  pollLineage,
} from "./lineage.ts";

function pr(overrides: Partial<LineagePr> & { prKey: string; status: string }): LineagePr {
  return {
    title: overrides.title ?? `title ${overrides.prKey}`,
    url: overrides.url ?? `https://github.com/${overrides.prKey.replace("#", "/pull/")}`,
    round: overrides.round ?? 1,
    processKey: overrides.processKey ?? "p1",
    outcome: overrides.outcome ?? null,
    ...overrides,
  };
}

// ── feature arc ──────────────────────────────────────────────────────────────────────────────

test("feature: implementing before any PR is handed off", () => {
  const t = deriveLineage(
    { kind: "feature", key: "o/r#1", title: "Add X", issueUrl: "u", status: "running", processKey: "f1" },
    [],
  );
  assertEquals(t.kind, "feature");
  assertEquals(t.stage, "implementing");
  assertEquals(t.stageLabel, "Implementing");
  assert(t.active, "an implementing run is active");
  assertEquals(t.processKey, "f1");
  assertEquals(t.prCount, 0);
});

test("feature: converging hands the narrative to the PR frontier", () => {
  const t = deriveLineage(
    { kind: "feature", key: "o/r#1", title: "Add X", issueUrl: "u", status: "converging", processKey: "f1" },
    [pr({ prKey: "o/r#2", status: "converging", round: 3, processKey: "c9" })],
  );
  assertEquals(t.stage, "converging");
  assertEquals(t.stageLabel, "Converging (round 3)");
  assertEquals(t.processKey, "c9", "frontier prefers the active PR's instance");
  assert(t.active);
  assertEquals(t.prKeys, ["o/r#2"]);
});

test("feature: a merged PR settles the arc (history)", () => {
  const t = deriveLineage(
    { kind: "feature", key: "o/r#1", title: "Add X", issueUrl: "u", status: "merged", processKey: "f1" },
    [pr({ prKey: "o/r#2", status: "merged" })],
  );
  assertEquals(t.stage, "merged");
  assertEquals(t.stageLabel, "Merged");
  assert(!t.active, "a merged arc has no active frontier");
});

test("feature: an escalated run surfaces the escalation stage", () => {
  const t = deriveLineage(
    { kind: "feature", key: "o/r#1", title: "X", issueUrl: "u", status: "escalated", processKey: "f1" },
    [],
  );
  assertEquals(t.stage, "escalated");
  assert(t.active);
});

// ── epic fan-out ─────────────────────────────────────────────────────────────────────────────

test("epic: rolls up N slice PRs and stays active while any is in flight", () => {
  const t = deriveLineage(
    { kind: "epic", key: "o/r#9", title: "Big epic", issueUrl: "u", status: "done", processKey: "e1", epicPhase: "Implementing (wave 2/3)" },
    [
      pr({ prKey: "o/r#10", status: "merged" }),
      pr({ prKey: "o/r#11", status: "converging", processKey: "c11" }),
      pr({ prKey: "o/r#12", status: "abandoned" }),
    ],
  );
  assertEquals(t.kind, "epic");
  assertEquals(t.stage, "converging");
  assertEquals(t.stageLabel, "1/3 slices merged, 1 converging");
  assertEquals(t.epicPhaseLabel, "Implementing (wave 2/3)", "an epic thread carries its stamped epic_phase down to member PRs");
  assertEquals(t.processKey, "c11");
  assertEquals(t.prCount, 3);
  assert(t.active);
});

test("epic: all slices merged settles as merged", () => {
  const t = deriveLineage(
    { kind: "epic", key: "o/r#9", title: "Big epic", issueUrl: "u", status: "done", processKey: "e1", epicPhase: null },
    [pr({ prKey: "o/r#10", status: "merged" }), pr({ prKey: "o/r#11", status: "merged" })],
  );
  assertEquals(t.stage, "merged");
  assertEquals(t.stageLabel, "2/2 slices merged");
  assertEquals(t.epicPhaseLabel, "2/2 slices merged", "a grandfathered epic (no epic_phase) falls back to its delivery-rollup stage label");
  assert(!t.active);
});

test("epic: mixed terminal (none in flight, not all merged) is resolved, not landed", () => {
  const t = deriveLineage(
    { kind: "epic", key: "o/r#9", title: "E", issueUrl: "u", status: "done", processKey: "e1", epicPhase: "Finalizing" },
    [pr({ prKey: "o/r#10", status: "merged" }), pr({ prKey: "o/r#11", status: "abandoned" })],
  );
  assertEquals(t.stage, "resolved");
  assert(!t.active);
});

test("epic: planning with no PRs yet", () => {
  const t = deriveLineage(
    { kind: "epic", key: "o/r#9", title: "E", issueUrl: "u", status: "planning", processKey: "e1", epicPhase: "Planning" },
    [],
  );
  assertEquals(t.stage, "planning");
  assert(t.active);
});

test("feature/self-rooted threads carry no epic phase label", () => {
  const feat = deriveLineage(
    { kind: "feature", key: "o/r#1", title: "X", issueUrl: "u", status: "converging", processKey: "f1" },
    [pr({ prKey: "o/r#2", status: "converging" })],
  );
  assertEquals(feat.epicPhaseLabel, null, "a feature PR is not an epic slice");
  const self = deriveLineage({ kind: "pr", key: "o/r#5" }, [pr({ prKey: "o/r#5", status: "converging" })]);
  assertEquals(self.epicPhaseLabel, null, "a self-rooted PR is not an epic slice");
});

// ── self-rooted (human/webhook) PR ───────────────────────────────────────────────────────────

test("pr: a human/webhook PR with no origin is its own root", () => {
  const t = deriveLineage({ kind: "pr", key: "o/r#5" }, [
    pr({ prKey: "o/r#5", status: "waiting_review", round: 2, title: "Fix bug" }),
  ]);
  assertEquals(t.kind, "pr");
  assertEquals(t.rootRequestKey, "o/r#5");
  assertEquals(t.stage, "reviewing");
  assertEquals(t.stageLabel, "Awaiting review (round 2)");
  assertEquals(t.title, "Fix bug", "a self-rooted PR takes its title from the PR");
  assertEquals(t.issueUrl, null);
  assert(t.active);
});

// ── poller projection ────────────────────────────────────────────────────────────────────────

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
      async delete(id: any) {
        const i = rows.findIndex((r) => r[pk] === id);
        if (i >= 0) rows.splice(i, 1);
      },
    };
  }
  const data = { table: (n: string, pk?: string) => tbl(n, pk) } as any as DataLayer;
  return { data, stores };
}

test("pollLineage: projects feature, epic, and self-rooted threads onto lineage_threads", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#1", title: "Feature", issue_url: "u1", status: "converging", process_key: "f1", pr_key: "o/r#100" },
  ];
  stores.plans = [
    { plan_key: "o/r#2", title: "Epic", issue_url: "u2", status: "done", process_key: "e1", epic_phase: "Implementing (wave 1/2)" },
  ];
  stores.plan_tasks = [
    { id: 1, plan_key: "o/r#2", pr_key: "o/r#200" },
    { id: 2, plan_key: "o/r#2", pr_key: "o/r#201" },
  ];
  stores.pull_requests = [
    { pr_key: "o/r#100", title: "Feat PR", url: "x", status: "converging", current_round: 2, process_key: "c1", outcome: null, root_request_key: "o/r#1" },
    { pr_key: "o/r#200", title: "S1", url: "x", status: "merged", current_round: 1, process_key: "c2", outcome: null, root_request_key: "o/r#2" },
    { pr_key: "o/r#201", title: "S2", url: "x", status: "converging", current_round: 1, process_key: "c3", outcome: null, root_request_key: "o/r#2" },
    // Human/webhook PR — no root_request_key.
    { pr_key: "o/r#300", title: "Human PR", url: "x", status: "merged", current_round: 1, process_key: "c4", outcome: null, root_request_key: null },
  ];

  await pollLineage(data);

  const threads: LineageThreadRow[] = stores.lineage_threads;
  assertEquals(threads.length, 3, "one feature, one epic, one self-rooted PR");

  const feat = threads.find((t) => t.root_request_key === "o/r#1");
  assert(feat, "feature thread present");
  assertEquals(feat?.kind, "feature");
  assertEquals(feat?.stage, "converging");
  assertEquals(feat?.stage_label, "Converging (round 2)");
  assertEquals(feat?.active, 1);
  assertEquals(JSON.parse(feat?.pr_keys ?? "[]"), ["o/r#100"]);

  const epic = threads.find((t) => t.root_request_key === "o/r#2");
  assertEquals(epic?.kind, "epic");
  assertEquals(epic?.stage, "converging");
  assertEquals(epic?.pr_count, 2);
  assertEquals(epic?.active, 1);

  const human = threads.find((t) => t.root_request_key === "o/r#300");
  assertEquals(human?.kind, "pr");
  assertEquals(human?.stage, "merged");
  assertEquals(human?.active, 0);

  // Epic-phase projection (#304): each epic slice PR gets its parent epic's phase label; the feature
  // and self-rooted PRs (not epic slices) are left NULL, so their PR-row detail shows no epic panel.
  const prById = (k: string) => stores.pull_requests.find((r: any) => r.pr_key === k);
  assertEquals(prById("o/r#200").epic_phase_label, "Implementing (wave 1/2)", "epic slice S1 carries the epic phase");
  assertEquals(prById("o/r#201").epic_phase_label, "Implementing (wave 1/2)", "epic slice S2 carries the epic phase");
  assertEquals(prById("o/r#100").epic_phase_label ?? null, null, "a feature PR is not an epic slice");
  assertEquals(prById("o/r#300").epic_phase_label ?? null, null, "a self-rooted PR is not an epic slice");

  // Idempotent: a second pass with no state change writes nothing new (same row count, same ts).
  const before = stores.lineage_threads.map((r: LineageThreadRow) => r.updated_at);
  await pollLineage(data);
  const after = stores.lineage_threads.map((r: LineageThreadRow) => r.updated_at);
  assertEquals(after, before, "steady-state pass is a no-op");
});

test("pollLineage: a self-rooted PR row (root_request_key === pr_key) projects exactly one thread keyed on its pr_key", async () => {
  // Regression (#245): submitPr now self-roots a human/webhook PR on its own `pr_key` (rather than
  // NULL) so the Lineage page's `lineage_threads.root_request_key → pull_requests.root_request_key`
  // drill-down join is non-empty. Guard that this row shape still projects a single self-rooted
  // thread keyed on the `pr_key` — not double-counted, and not grouped under a phantom origin.
  const { data, stores } = memData();
  stores.feature_runs = [];
  stores.plans = [];
  stores.plan_tasks = [];
  stores.pull_requests = [
    { pr_key: "o/r#42", title: "Human PR", url: "x", status: "converging", current_round: 1, process_key: "c9", outcome: null, root_request_key: "o/r#42" },
  ];

  await pollLineage(data);

  const threads: LineageThreadRow[] = stores.lineage_threads;
  assertEquals(threads.length, 1, "one self-rooted thread");
  assertEquals(threads[0].root_request_key, "o/r#42", "thread key equals the PR row's root_request_key so the page join drills down");
  assertEquals(threads[0].kind, "pr");
  assertEquals(JSON.parse(threads[0].pr_keys ?? "[]"), ["o/r#42"]);
  assertEquals(threads[0].pr_count, 1);
});

test("pollLineage: an orphaned non-null root (origin row gone) keys the thread on the stored root, not pr_key", async () => {
  // Regression (#245 review): a PR whose `root_request_key` points at a feature/epic origin row that
  // no longer survives is unclaimed by any feature/epic thread. Keying its self-rooted thread on
  // `pr_key` would leave `lineage_threads.root_request_key` (= pr_key) ≠ `pull_requests.root_request_key`
  // (= the orphaned root), so the page's drill-down join renders an empty PR list. The thread MUST be
  // keyed on the stored `root_request_key`. Two PRs sharing one orphaned root belong to one thread.
  const { data, stores } = memData();
  stores.feature_runs = [];
  stores.plans = [];
  stores.plan_tasks = [];
  stores.pull_requests = [
    { pr_key: "o/r#71", title: "Orphan A", url: "x", status: "converging", current_round: 1, process_key: "c1", outcome: null, root_request_key: "o/r#7" },
    { pr_key: "o/r#72", title: "Orphan B", url: "x", status: "merged", current_round: 1, process_key: "c2", outcome: null, root_request_key: "o/r#7" },
  ];

  await pollLineage(data);

  const threads: LineageThreadRow[] = stores.lineage_threads;
  assertEquals(threads.length, 1, "both orphaned PRs group into one thread under their shared root");
  assertEquals(
    threads[0].root_request_key,
    "o/r#7",
    "thread key equals the stored root_request_key so the page join drills down, not the pr_key",
  );
  assertEquals(threads[0].kind, "pr");
  assertEquals(JSON.parse(threads[0].pr_keys ?? "[]").sort(), ["o/r#71", "o/r#72"]);
  assertEquals(threads[0].pr_count, 2);
});

test("listLineage: unknown root returns nothing; known roots stitched", async () => {
  const { data } = memData();
  const threads = await listLineage(data);
  assertEquals(threads.length, 0);
});

test("listLineage: deterministic order — active frontier first, then by rootRequestKey", async () => {
  // Guard the tie-break (#245 review): equal-`active` threads have no per-thread timestamp to sort
  // on, so ordering must fall back to `rootRequestKey` for a stable, deterministic response instead
  // of jittering across passes. Insert settled roots out of order plus one active root.
  const { data, stores } = memData();
  stores.feature_runs = [];
  stores.plans = [];
  stores.plan_tasks = [];
  stores.pull_requests = [
    { pr_key: "o/r#3", title: "c", url: "x", status: "merged", current_round: 1, process_key: null, outcome: null, root_request_key: "o/r#3" },
    { pr_key: "o/r#1", title: "a", url: "x", status: "merged", current_round: 1, process_key: null, outcome: null, root_request_key: "o/r#1" },
    { pr_key: "o/r#2", title: "b", url: "x", status: "converging", current_round: 1, process_key: "c9", outcome: null, root_request_key: "o/r#2" },
  ];

  const threads = await listLineage(data);
  assertEquals(
    threads.map((t) => t.rootRequestKey),
    ["o/r#2", "o/r#1", "o/r#3"],
    "active first, then inactive sorted by rootRequestKey",
  );
});
