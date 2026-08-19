// Unit tests for the spec-conformance review stage (app/conformance.ts, 052_plan_conformance.sql).
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import { memBlackboardSource } from "../test/blackboardDb.ts";
import { appendEntry } from "./blackboard.ts";
import {
  acknowledgeConformance,
  activeConformanceReviews,
  gatherConformance,
  hasDeliveredImplementation,
  hasDeliveredImplementationForPlan,
  recordConformance,
  renderConformanceBrief,
} from "./conformance.ts";

// In-memory record gateway matching the Table<T> subset conformance.ts uses.
function memData(): { data: DataLayer; stores: Record<string, any[]> } {
  const stores: Record<string, any[]> = {};
  const seq: Record<string, number> = {};
  function tbl(name: string, pk = "id") {
    const rows = (stores[name] ??= [] as any[]);
    const match = (r: any, where: any) => Object.entries(where).every(([k, v]) => r[k] === v);
    return {
      async insert(row: any) {
        if (pk !== "id" && rows.some((r) => r[pk] === row[pk])) {
          throw new Error(`UNIQUE constraint failed: ${name}.${pk}`);
        }
        const id = (seq[name] = (seq[name] ?? 0) + 1);
        rows.push(pk === "id" ? { id, ...row } : { ...row });
        return pk === "id" ? id : row[pk];
      },
      async find(where: any = {}) {
        return rows.filter((r) => match(r, where));
      },
      async findOne(where: any = {}) {
        return rows.find((r) => match(r, where));
      },
      async get(id: any) {
        return rows.find((row) => row[pk] === id);
      },
      async update(id: any, patch: any) {
        const r = rows.find((row) => row[pk] === id);
        if (r) Object.assign(r, patch);
      },
    };
  }
  const data = { table: (n: string, pk?: string) => tbl(n, pk), source: memBlackboardSource().source } as any as DataLayer;
  return { data, stores };
}

const PLAN = "acme/widgets#7";

function seedPlan(stores: Record<string, any[]>) {
  stores["plans"] = [{
    plan_key: PLAN,
    repo: "acme/widgets",
    issue_url: "https://github.com/acme/widgets/issues/7",
    title: "Widgets epic",
    status: "done",
  }];
}
function seedTask(stores: Record<string, any[]>, task: Record<string, unknown>) {
  (stores["plan_tasks"] ??= []).push({ plan_key: PLAN, ...task });
}
function seedPr(stores: Record<string, any[]>, pr_key: string, status: string) {
  (stores["pull_requests"] ??= []).push({ pr_key, status });
}

test("gatherConformance: collects the spec, only LANDED PRs, and raised scope-changes", async () => {
  const { data, stores } = memData();
  seedPlan(stores);
  seedTask(stores, { id: 1, task_index: 0, task_id: "t1", title: "Auth", prompt: "add JWT auth", status: "opened", pr_key: "acme/widgets#10" });
  seedTask(stores, { id: 2, task_index: 1, task_id: "t2", title: "Rate limit", prompt: "add rate limiting", status: "opened", pr_key: "acme/widgets#11" });
  seedTask(stores, { id: 3, task_index: 2, task_id: "t3", title: "Webhook", prompt: "retry webhooks", status: "opened", pr_key: "acme/widgets#12" });
  seedTask(stores, { id: 4, task_index: 3, task_id: "t4", title: "Docs", prompt: "write docs", status: "skipped", pr_key: null });
  seedPr(stores, "acme/widgets#10", "merged"); // landed
  seedPr(stores, "acme/widgets#11", "converged"); // landed (review-only)
  seedPr(stores, "acme/widgets#12", "abandoned"); // NOT landed
  await appendEntry(data, PLAN, { author_task: "t2", kind: "scope-change", body: "narrowed rate limit to per-IP only" });
  await appendEntry(data, PLAN, { author_task: "t1", kind: "learning", body: "not a scope change" });

  const d = await gatherConformance(data, PLAN);
  assertEquals(d.repo, "acme/widgets");
  assertEquals(d.issueUrl, "https://github.com/acme/widgets/issues/7");
  assertEquals(d.slices.length, 4);
  // Only merged/converged PRs are "delivered"; abandoned and task-less slices are excluded.
  assertEquals(d.deliveredPrs, ["acme/widgets#10", "acme/widgets#11"]);
  assertEquals(d.slices.find((s) => s.taskId === "t3")?.landed, false);
  assertEquals(d.slices.find((s) => s.taskId === "t4")?.landed, false);
  // Only scope-change entries surface as raised deviations — learnings are ignored.
  assertEquals(d.scopeChanges.length, 1);
  assertEquals(d.scopeChanges[0].author_task, "t2");
});

test("gatherConformance: sorts slices by task_index", async () => {
  const { data, stores } = memData();
  seedPlan(stores);
  seedTask(stores, { id: 1, task_index: 2, task_id: "t3", status: "skipped", pr_key: null });
  seedTask(stores, { id: 2, task_index: 0, task_id: "t1", status: "skipped", pr_key: null });
  seedTask(stores, { id: 3, task_index: 1, task_id: "t2", status: "skipped", pr_key: null });
  const d = await gatherConformance(data, PLAN);
  assertEquals(d.slices.map((s) => s.taskId), ["t1", "t2", "t3"]);
});

test("gatherConformance: uses pre-fetched blackboard entries instead of re-scanning", async () => {
  const { data, stores } = memData();
  seedPlan(stores);
  seedTask(stores, { id: 1, task_index: 0, task_id: "t1", status: "skipped", pr_key: null });
  // A scope-change lives in the store, but the caller passes an EMPTY pre-fetched snapshot — the
  // function must honour what it was handed and not re-read the store.
  await appendEntry(data, PLAN, { author_task: "t1", kind: "scope-change", body: "should be ignored" });
  const d = await gatherConformance(data, PLAN, []);
  assertEquals(d.scopeChanges.length, 0);
});

test("hasDeliveredImplementation: true iff at least one PR landed", async () => {
  const { data, stores } = memData();
  seedPlan(stores);
  seedTask(stores, { id: 1, task_index: 0, task_id: "t1", status: "opened", pr_key: "acme/widgets#10" });
  seedPr(stores, "acme/widgets#10", "abandoned");
  assert(!hasDeliveredImplementation(await gatherConformance(data, PLAN)));
  stores["pull_requests"] = [{ pr_key: "acme/widgets#10", status: "merged" }];
  assert(hasDeliveredImplementation(await gatherConformance(data, PLAN)));
});

test("hasDeliveredImplementationForPlan: matches the digest without a blackboard scan", async () => {
  const { data, stores } = memData();
  seedPlan(stores);
  seedTask(stores, { id: 1, task_index: 0, task_id: "t1", status: "opened", pr_key: "acme/widgets#10" });
  seedTask(stores, { id: 2, task_index: 1, task_id: "t2", status: "skipped", pr_key: null });
  seedPr(stores, "acme/widgets#10", "abandoned");
  // No landed PR yet — agrees with the full-digest helper.
  assertEquals(await hasDeliveredImplementationForPlan(data, PLAN), false);
  assertEquals(hasDeliveredImplementation(await gatherConformance(data, PLAN)), false);
  // A landed PR flips both to true.
  stores["pull_requests"] = [{ pr_key: "acme/widgets#10", status: "converged" }];
  assertEquals(await hasDeliveredImplementationForPlan(data, PLAN), true);
  assertEquals(hasDeliveredImplementation(await gatherConformance(data, PLAN)), true);
  // The cheap check must not touch the blackboard.
  const before = (stores["blackboard"] ?? []).length;
  await hasDeliveredImplementationForPlan(data, PLAN);
  assertEquals((stores["blackboard"] ?? []).length, before);
});

test("renderConformanceBrief: lists PRs to examine, the spec, and raised deviations", () => {
  const brief = renderConformanceBrief({
    planKey: PLAN,
    repo: "acme/widgets",
    issueUrl: "https://x/7",
    title: "Epic",
    slices: [
      { taskId: "t1", title: "Auth", prompt: "add JWT auth", status: "opened", prKey: "acme/widgets#10", landed: true },
      { taskId: "t2", title: "Docs", prompt: null, status: "skipped", prKey: null, landed: false },
    ],
    deliveredPrs: ["acme/widgets#10"],
    scopeChanges: [{ author_task: "t1", body: "narrowed to per-IP", created_at: "now" }],
  });
  assertStringIncludes(brief, "gh pr diff");
  assertStringIncludes(brief, "acme/widgets#10");
  assertStringIncludes(brief, "add JWT auth");
  assertStringIncludes(brief, "narrowed to per-IP");
  assertStringIncludes(brief, "RAISED during implementation");
});

test("renderConformanceBrief: states 'none' for no delivered PRs and no scope-changes", () => {
  const brief = renderConformanceBrief({
    planKey: PLAN, repo: "acme/widgets", issueUrl: "", title: null,
    slices: [], deliveredPrs: [], scopeChanges: [],
  });
  assertStringIncludes(brief, "no implementation to verify");
  assertStringIncludes(brief, "treat any deviation you find as UNRAISED");
});

test("recordConformance: inserts then updates the same plan_key row in place", async () => {
  const { data, stores } = memData();
  await recordConformance(data, PLAN, {
    status: "filed",
    commentUrl: "https://x/7#issuecomment-1",
    slicesMet: 4,
    slicesReduced: 1,
    slicesNotVerified: 1,
    deviationsRaised: 2,
    deviationsUnraised: 1,
    hasDeviations: true,
    summary: "6 items, 4 met",
    report: "full report",
  });
  assertEquals(stores["plan_conformance"].length, 1);
  const row = stores["plan_conformance"][0];
  assertEquals(row.status, "filed");
  assertEquals(row.comment_url, "https://x/7#issuecomment-1");
  assertEquals(row.slices_met, 4);
  assertEquals(row.has_deviations, 1);

  await recordConformance(data, PLAN, { status: "skipped", summary: "nothing shipped" });
  assertEquals(stores["plan_conformance"].length, 1, "same plan_key must not duplicate");
  assertEquals(stores["plan_conformance"][0].status, "skipped");
  assertEquals(stores["plan_conformance"][0].has_deviations, 0);
});

test("recordConformance: rethrows a non-unique (FOREIGN KEY) constraint error instead of swallowing it", async () => {
  let updated = false;
  const table = {
    async insert() {
      throw new Error("FOREIGN KEY constraint failed");
    },
    async update() {
      updated = true;
    },
  };
  const data = { table: () => table } as any as DataLayer;
  let threw = false;
  try {
    await recordConformance(data, PLAN, { status: "filed" });
  } catch (err) {
    threw = true;
    assertStringIncludes(String(err), "FOREIGN KEY");
  }
  assert(threw, "the FK error must propagate");
  assertEquals(updated, false, "must not silently fall back to update on a non-unique error");
});

test("recordConformance: persists the retro instance key and the escalation review_status (issue #216)", async () => {
  const { data, stores } = memData();
  await recordConformance(data, PLAN, {
    status: "filed",
    commentUrl: "https://x/7#c",
    hasDeviations: true,
    summary: "slice 2 reduced",
    processKey: "retro-inst-7",
    reviewStatus: "reviewing",
  });
  const row = stores["plan_conformance"][0];
  assertEquals(row.process_key, "retro-inst-7");
  assertEquals(row.review_status, "reviewing");

  // Absent tracking fields default: no processKey, and a settled `reviewed`.
  await recordConformance(data, "acme/widgets#8", { status: "skipped" });
  const clean = stores["plan_conformance"].find((r) => r.plan_key === "acme/widgets#8");
  assertEquals(clean.process_key, null);
  assertEquals(clean.review_status, "reviewed");
});

test("activeConformanceReviews: returns only the rows still `reviewing`", async () => {
  const { data, stores } = memData();
  stores["plan_conformance"] = [
    { plan_key: "a/b#1", process_key: "p1", review_status: "reviewing", summary: "s1" },
    { plan_key: "a/b#2", process_key: "p2", review_status: "reviewed", summary: "s2" },
  ];
  const active = await activeConformanceReviews(data);
  assertEquals(active.map((r) => r.plan_key), ["a/b#1"]);
});

test("acknowledgeConformance: settles the row at reviewed and folds the note into the summary", async () => {
  const { data, stores } = memData();
  stores["plan_conformance"] = [
    { plan_key: PLAN, process_key: "p1", review_status: "reviewing", summary: "slice 2 reduced" },
  ];
  await acknowledgeConformance(data, PLAN, "filed follow-up #9");
  const row = stores["plan_conformance"][0];
  assertEquals(row.review_status, "reviewed");
  assertEquals(row.summary, "slice 2 reduced\n\nOperator ack: filed follow-up #9");
});

test("acknowledgeConformance: a blank note settles the row without changing the summary", async () => {
  const { data, stores } = memData();
  stores["plan_conformance"] = [
    { plan_key: PLAN, process_key: "p1", review_status: "reviewing", summary: "auth cache unverified" },
  ];
  await acknowledgeConformance(data, PLAN, "  ");
  assertEquals(stores["plan_conformance"][0].review_status, "reviewed");
  assertEquals(stores["plan_conformance"][0].summary, "auth cache unverified");
});
