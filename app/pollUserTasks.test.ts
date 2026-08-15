// Integration test for `pollUserTasks` (issue #236) — the reconcile that projects the engine's
// currently-open native user-task escalations onto the unified `user_tasks` read-model the Tasks page
// reads. It generalises the two feature pollers across every subject: feature runs (denormalised
// keys), in-flight plans (`plan-review-decision` / `trial-merge-decision`), and in-flight PRs
// (`wait-answer`). A completed task's row is removed on the next pass so `showCount` tracks live work.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import { pollUserTasks } from "./service.ts";

// biome-ignore lint/suspicious/noExplicitAny: in-memory table double, mirrors featureEscalation.test.ts
function memData(seed: Record<string, any[]> = {}): { data: DataLayer; stores: Record<string, any[]> } {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const stores: Record<string, any[]> = {};
  for (const [k, v] of Object.entries(seed)) stores[k] = v.map((r) => ({ ...r }));
  function tbl(name: string, pk = "id") {
    // biome-ignore lint/suspicious/noExplicitAny: see above
    const rows = (stores[name] ??= [] as any[]);
    // biome-ignore lint/suspicious/noExplicitAny: see above
    const match = (r: any, where: any) => Object.entries(where).every(([k, v]) => r[k] === v);
    return {
      async all() {
        return rows.slice();
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async get(id: any) {
        return rows.find((r) => r[pk] === id);
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async find(where: any = {}) {
        return rows.filter((r) => match(r, where));
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async insert(r: any) {
        rows.push({ ...r });
        return r[pk];
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async update(id: any, patch: any) {
        const r = rows.find((row) => row[pk] === id);
        if (r) Object.assign(r, patch);
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async delete(id: any) {
        const i = rows.findIndex((r) => r[pk] === id);
        if (i >= 0) rows.splice(i, 1);
      },
    };
  }
  const data = { table: (n: string, pk?: string) => tbl(n, pk) } as unknown as DataLayer;
  return { data, stores };
}

/** A fake engine whose open user tasks are keyed by processInstanceKey (the only field the poller
 *  queries on for plan / PR instances). */
function fakeEngine(byInstance: Record<string, { userTaskKey: string; elementId?: string }[]>): EngineClient {
  return {
    searchUserTasks: (filter?: { processInstanceKey?: string }) =>
      Promise.resolve(filter?.processInstanceKey ? (byInstance[filter.processInstanceKey] ?? []) : []),
  } as unknown as EngineClient;
}

test("pollUserTasks: projects feature / plan-review / trial-merge / PR-wait escalations into user_tasks", async () => {
  const { data, stores } = memData({
    feature_runs: [
      {
        feature_key: "o/r#10",
        status: "escalated",
        process_key: "fp-10",
        issue_url: "https://github.com/o/r/issues/10",
        escalation_user_task_key: "ut-feat",
        escalation_question: "which framework?",
        blocked_user_task_key: null,
        delivery_label: null,
      },
    ],
    plans: [
      { plan_key: "o/r#20", status: "dispatched", process_key: "pp-20", issue_url: "https://github.com/o/r/issues/20" },
      { plan_key: "o/r#21", status: "done", process_key: "pp-21", issue_url: "https://github.com/o/r/issues/21" },
    ],
    plan_reviews: [
      { plan_key: "o/r#20", epoch: 0, round: 0, approved: 0, findings: "scope was fine", created_at: "2025-01-01T00:00:00.000Z" },
      { plan_key: "o/r#20", epoch: 0, round: 1, approved: 0, findings: "scope too broad", created_at: "2025-01-02T00:00:00.000Z" },
    ],
    plan_trial_merges: [
      { id: 1, plan_key: "o/r#20", wave: 0, result: "suite-failed", summary: "wave 0 red", resolved: 0 },
    ],
    pull_requests: [
      { pr_key: "o/r#30", status: "escalated", process_key: "rp-30", url: "https://github.com/o/r/pull/30" },
    ],
    escalations: [{ id: 1, pr_key: "o/r#30", status: "open", question: "conflicting reviews" }],
  });
  const engine = fakeEngine({
    "pp-20": [
      { userTaskKey: "ut-plan", elementId: "plan-review-decision" },
      { userTaskKey: "ut-trial", elementId: "trial-merge-decision" },
    ],
    "pp-21": [{ userTaskKey: "ut-terminal", elementId: "plan-review-decision" }],
    "rp-30": [{ userTaskKey: "ut-pr", elementId: "wait-answer" }],
  });

  await pollUserTasks(data, engine);

  const byKey = Object.fromEntries((stores.user_tasks ?? []).map((r) => [r.user_task_key, r]));
  assertEquals(Object.keys(byKey).sort(), ["ut-feat", "ut-plan", "ut-pr", "ut-trial"]);
  assertEquals(byKey["ut-feat"].kind_label, "Feature escalation");
  assertEquals(byKey["ut-feat"].question, "which framework?");
  assertEquals(byKey["ut-plan"].kind_label, "Plan review");
  assertEquals(byKey["ut-plan"].question, "scope too broad");
  assertEquals(byKey["ut-trial"].kind_label, "Trial merge");
  assertEquals(byKey["ut-trial"].question, "wave 0 red");
  assertEquals(byKey["ut-pr"].kind_label, "PR review");
  assertEquals(byKey["ut-pr"].subject_type, "pr");
  assertEquals(byKey["ut-pr"].question, "conflicting reviews");
});

test("pollUserTasks: removes a row once its task is no longer open (completed / out-of-band)", async () => {
  const { data, stores } = memData({
    user_tasks: [
      {
        user_task_key: "ut-old",
        element_id: "wait-answer",
        kind_label: "PR review",
        subject_type: "pr",
        subject_key: "o/r#30",
        subject_url: null,
        question: null,
        process_key: "rp-30",
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      },
    ],
    pull_requests: [{ pr_key: "o/r#30", status: "converging", process_key: "rp-30", url: "https://github.com/o/r/pull/30" }],
  });
  const engine = fakeEngine({ "rp-30": [] });

  await pollUserTasks(data, engine);

  assertEquals(stores.user_tasks, []);
});

test("pollUserTasks: skips terminal plans and PRs without a process key", async () => {
  const { data, stores } = memData({
    plans: [{ plan_key: "o/r#40", status: "planning", process_key: null, issue_url: "https://github.com/o/r/issues/40" }],
  });
  const engine = fakeEngine({});

  await pollUserTasks(data, engine);

  assertEquals(stores.user_tasks ?? [], []);
});
