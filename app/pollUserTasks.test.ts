// Integration test for `pollUserTasks` (issue #236) — the reconcile that projects the engine's
// currently-open native user-task escalations onto the unified `user_tasks` read-model the Tasks page
// reads. It reads each in-flight subject's open tasks from the engine directly: feature runs
// (`feature-escalation` / `feature-blocked`, issue #332), in-flight plans (`plan-review-decision` /
// `trial-merge-decision`), and in-flight PRs (`wait-answer`). A completed task's row is removed on the
// next pass so `showCount` tracks live work.
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

/** A single engine-reported user task in the fixture. `state` mirrors the engine lifecycle; it
 *  defaults to `"CREATED"` (the only open/answerable state) so existing fixtures read as live tasks.
 *  A looping instance holds multiple tasks for one element (COMPLETED from prior rounds + the live one). */
type FakeTask = { userTaskKey: string; elementId?: string; state?: "CREATED" | "COMPLETED" | "CANCELED" };

/** A fake engine whose user tasks are keyed by processInstanceKey (the only field the poller queries on
 *  for plan / PR instances). It models the real engine's two accessors from ONE fixture so a test
 *  genuinely exercises the lifecycle-state filtering: `searchUserTasks` returns tasks in ANY state
 *  (COMPLETED first, as the live API does — issue #294), while `openUserTasks` pins `state:"CREATED"`. */
function fakeEngine(byInstance: Record<string, FakeTask[]>): EngineClient {
  const all = (filter?: { processInstanceKey?: string }) =>
    filter?.processInstanceKey ? (byInstance[filter.processInstanceKey] ?? []) : [];
  return {
    searchUserTasks: (filter?: { processInstanceKey?: string }) => Promise.resolve(all(filter)),
    openUserTasks: (filter?: { processInstanceKey?: string }) =>
      Promise.resolve(all(filter).filter((t) => (t.state ?? "CREATED") === "CREATED")),
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
        title: "Add the framework selector",
        delivery_label: null,
      },
    ],
    feature_escalations: [
      { id: 1, feature_key: "o/r#10", question: "which framework?", created_at: "2025-01-01T00:00:00.000Z", job_key: "j1" },
    ],
    plans: [
      { plan_key: "o/r#20", status: "dispatched", process_key: "pp-20", issue_url: "https://github.com/o/r/issues/20", title: "Broaden the epic scope" },
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
      { pr_key: "o/r#30", status: "escalated", process_key: "rp-30", url: "https://github.com/o/r/pull/30", title: "Resolve the reviews" },
    ],
    escalations: [{ id: 1, pr_key: "o/r#30", status: "open", question: "conflicting reviews" }],
  });
  const engine = fakeEngine({
    "fp-10": [{ userTaskKey: "ut-feat", elementId: "feature-escalation" }],
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
  assertEquals(byKey["ut-feat"].subject_title, "Add the framework selector");
  assertEquals(byKey["ut-plan"].kind_label, "Plan review");
  assertEquals(byKey["ut-plan"].question, "scope too broad");
  assertEquals(byKey["ut-plan"].subject_title, "Broaden the epic scope");
  assertEquals(byKey["ut-trial"].kind_label, "Trial merge");
  assertEquals(byKey["ut-trial"].question, "wave 0 red");
  assertEquals(byKey["ut-trial"].subject_title, "Broaden the epic scope");
  assertEquals(byKey["ut-pr"].kind_label, "PR review");
  assertEquals(byKey["ut-pr"].subject_type, "pr");
  assertEquals(byKey["ut-pr"].question, "conflicting reviews");
  assertEquals(byKey["ut-pr"].subject_title, "Resolve the reviews");
});

test("pollUserTasks: projects a feature-escalation that lands on a plan-fanout plan instance (issue #358)", async () => {
  // plan-fanout embeds each wave slice as a multi-instance `implement` subprocess, so a slice that
  // escalates parks on the `feature-escalation` user task on the PLAN-ROOT process instance — never on
  // a standalone `feature_runs` instance. The feature scan above only walks `feature_runs`, so before
  // #358 the plan scan's hardcoded {plan-review, trial-merge} whitelist silently dropped it and the
  // escalation was invisible in the Tasks inbox (the instance-19153 orphan). The plan scan must project
  // EVERY open user-task element in the canonical registry, keyed to the epic (plan) subject, sourcing
  // the question from the `feature_escalations` audit log the escalate arm writes (keyed by plan_key).
  const { data, stores } = memData({
    plans: [
      { plan_key: "o/r#64", status: "dispatched", process_key: "pp-64", issue_url: "https://github.com/o/r/issues/64", title: "Learn BPMN scaffold" },
    ],
    feature_escalations: [
      { id: 1, feature_key: "o/r#64", question: "the agent returned no machine-readable result — enrol the PR?", created_at: "2025-01-01T00:00:00.000Z", job_key: "j1" },
    ],
  });
  const engine = fakeEngine({ "pp-64": [{ userTaskKey: "ut-embedded-feat", elementId: "feature-escalation" }] });

  await pollUserTasks(data, engine);

  const byKey = Object.fromEntries((stores.user_tasks ?? []).map((r) => [r.user_task_key, r]));
  assertEquals(Object.keys(byKey), ["ut-embedded-feat"]);
  assertEquals(byKey["ut-embedded-feat"].element_id, "feature-escalation");
  assertEquals(byKey["ut-embedded-feat"].kind_label, "Feature escalation");
  assertEquals(byKey["ut-embedded-feat"].subject_type, "plan");
  assertEquals(byKey["ut-embedded-feat"].subject_key, "o/r#64");
  assertEquals(byKey["ut-embedded-feat"].subject_title, "Learn BPMN scaffold");
  assertEquals(byKey["ut-embedded-feat"].question, "the agent returned no machine-readable result — enrol the PR?");
});

test("pollUserTasks: projects a merge-loop wait-merge-answer escalation into user_tasks as \"PR merge\"", async () => {
  // During the merge phase a PR's process_key points at its merge-loop instance; the merge escalation
  // parks on a native `wait-merge-answer` userTask (#256) and writes the SAME `escalations` row the
  // review loop does, so the inbox surfaces it exactly like a review escalation — just labelled by
  // stage. This guards the poller accepting the merge element alongside `wait-answer`.
  const { data, stores } = memData({
    pull_requests: [
      { pr_key: "o/r#31", status: "escalated", process_key: "mp-31", url: "https://github.com/o/r/pull/31" },
    ],
    escalations: [{ id: 1, pr_key: "o/r#31", status: "open", question: "not mergeable — resolve the conflict" }],
  });
  const engine = fakeEngine({ "mp-31": [{ userTaskKey: "ut-merge", elementId: "wait-merge-answer" }] });

  await pollUserTasks(data, engine);

  const byKey = Object.fromEntries((stores.user_tasks ?? []).map((r) => [r.user_task_key, r]));
  assertEquals(Object.keys(byKey), ["ut-merge"]);
  assertEquals(byKey["ut-merge"].element_id, "wait-merge-answer");
  assertEquals(byKey["ut-merge"].kind_label, "PR merge");
  assertEquals(byKey["ut-merge"].subject_type, "pr");
  assertEquals(byKey["ut-merge"].question, "not mergeable — resolve the conflict");
});

test("pollUserTasks: sources the feature-escalation question from the feature_escalations audit log (issue #305/#332)", async () => {
  // The canonical (and now sole) source is the append-only `feature_escalations` log — what
  // `record-feature-escalation` writes; issue #332 dropped the denormalised `feature_runs.escalation_question`
  // column. When several audit rows exist the newest wins, so a re-escalation shows the latest question.
  const { data, stores } = memData({
    feature_runs: [
      {
        feature_key: "o/r#42",
        status: "escalated",
        process_key: "fp-42",
        issue_url: "https://github.com/o/r/issues/42",
        title: "Wire the audit log",
        delivery_label: null,
      },
    ],
    feature_escalations: [
      { id: 1, feature_key: "o/r#42", question: "first ask", created_at: "2025-01-01T00:00:00.000Z", job_key: "j1" },
      { id: 2, feature_key: "o/r#42", question: "latest ask", created_at: "2025-01-02T00:00:00.000Z", job_key: "j2" },
    ],
  });
  const engine = fakeEngine({ "fp-42": [{ userTaskKey: "ut-feat", elementId: "feature-escalation" }] });

  await pollUserTasks(data, engine);

  const byKey = Object.fromEntries((stores.user_tasks ?? []).map((r) => [r.user_task_key, r]));
  assertEquals(byKey["ut-feat"].question, "latest ask");
});

test("pollUserTasks: projects a blocked feature run (feature-blocked) with the delivery_label as its question (issue #332)", async () => {
  // A blocked run parks on the native `feature-blocked` operator task at the non-terminal
  // `awaiting_operator` status. The poller reads it from the engine directly (no denormalised pointer)
  // and projects it onto the Tasks inbox, sourcing the display text from the run's `delivery_label`.
  const { data, stores } = memData({
    feature_runs: [
      {
        feature_key: "o/r#60",
        status: "awaiting_operator",
        process_key: "fp-60",
        issue_url: "https://github.com/o/r/issues/60",
        title: "Blocked slice",
        delivery_label: "agent gave up: no PR",
      },
    ],
  });
  const engine = fakeEngine({ "fp-60": [{ userTaskKey: "ut-blocked", elementId: "feature-blocked" }] });

  await pollUserTasks(data, engine);

  const byKey = Object.fromEntries((stores.user_tasks ?? []).map((r) => [r.user_task_key, r]));
  assertEquals(Object.keys(byKey), ["ut-blocked"]);
  assertEquals(byKey["ut-blocked"].element_id, "feature-blocked");
  assertEquals(byKey["ut-blocked"].subject_type, "feature");
  assertEquals(byKey["ut-blocked"].question, "agent gave up: no PR");
});

test("pollUserTasks: projects a conformance-escalation ack (issue #216) keyed to the epic, question from summary", async () => {
  // The advisory `retro` process parks on a native `conformance-escalation` user task when the
  // spec-conformance audit found the epic did not cleanly meet its spec. retro is not a delivery
  // aggregate, so its instance is tracked on `plan_conformance` (review_status = 'reviewing'); the
  // poller scans those rows, reads the open ack task from the engine, and projects it under the epic
  // (plan) subject with the audit `summary` as its question. A settled ('reviewed') row is skipped.
  const { data, stores } = memData({
    plan_conformance: [
      {
        plan_key: "o/r#70",
        process_key: "cp-70",
        review_status: "reviewing",
        summary: "slice 2 reduced; auth cache never verified",
      },
      { plan_key: "o/r#71", process_key: "cp-71", review_status: "reviewed", summary: "all clean" },
    ],
    plans: [
      { plan_key: "o/r#70", status: "done", issue_url: "https://github.com/o/r/issues/70", title: "Ship the cache" },
    ],
  });
  const engine = fakeEngine({
    "cp-70": [{ userTaskKey: "ut-conf", elementId: "conformance-escalation" }],
    "cp-71": [{ userTaskKey: "ut-conf-settled", elementId: "conformance-escalation" }],
  });

  await pollUserTasks(data, engine);

  const byKey = Object.fromEntries((stores.user_tasks ?? []).map((r) => [r.user_task_key, r]));
  assertEquals(Object.keys(byKey), ["ut-conf"]);
  assertEquals(byKey["ut-conf"].element_id, "conformance-escalation");
  assertEquals(byKey["ut-conf"].kind_label, "Conformance review");
  assertEquals(byKey["ut-conf"].subject_type, "plan");
  assertEquals(byKey["ut-conf"].subject_key, "o/r#70");
  assertEquals(byKey["ut-conf"].subject_title, "Ship the cache");
  assertEquals(byKey["ut-conf"].question, "slice 2 reduced; auth cache never verified");
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

// ── Defect-class guard (issue #294): a looping instance holds MULTIPLE tasks for one element ───────
// The plan-review (review→revise→review) and PR-wait (escalate→answer→re-escalate) elements sit on a
// loop, so a looping instance holds a COMPLETED task from a prior round alongside the live CREATED one,
// and the engine returns the COMPLETED one first. Scoping the query to open (CREATED) tasks projects
// only the live completable key onto `user_tasks`, never a terminal one the page could not complete.
test("pollUserTasks: a looping plan/PR projects only the CREATED task, never the COMPLETED one", async () => {
  const { data, stores } = memData({
    plans: [{ plan_key: "o/r#50", status: "dispatched", process_key: "pp-50", issue_url: "https://github.com/o/r/issues/50" }],
    plan_reviews: [{ plan_key: "o/r#50", epoch: 0, round: 0, approved: 0, findings: "scope too broad", created_at: "2025-01-01T00:00:00.000Z" }],
    pull_requests: [{ pr_key: "o/r#51", status: "escalated", process_key: "rp-51", url: "https://github.com/o/r/pull/51" }],
    escalations: [{ id: 1, pr_key: "o/r#51", status: "open", question: "conflicting reviews" }],
  });
  // Each looping instance returns its COMPLETED prior-round task FIRST, then the live CREATED one.
  const engine = fakeEngine({
    "pp-50": [
      { userTaskKey: "ut-plan-completed", elementId: "plan-review-decision", state: "COMPLETED" },
      { userTaskKey: "ut-plan-live", elementId: "plan-review-decision", state: "CREATED" },
    ],
    "rp-51": [
      { userTaskKey: "ut-pr-completed", elementId: "wait-answer", state: "COMPLETED" },
      { userTaskKey: "ut-pr-live", elementId: "wait-answer", state: "CREATED" },
    ],
  });

  await pollUserTasks(data, engine);

  const keys = (stores.user_tasks ?? []).map((r) => r.user_task_key).sort();
  // Only the live CREATED keys — the COMPLETED prior-round tasks must never surface a dead affordance.
  assertEquals(keys, ["ut-plan-live", "ut-pr-live"]);
});

// Self-heal reached: an instance whose only task for an element is COMPLETED yields no open task, so
// its row is removed (open-task query returns []), rather than pinning a dead completable pointer.
test("pollUserTasks: an instance whose only task is COMPLETED surfaces no row", async () => {
  const { data, stores } = memData({
    plans: [{ plan_key: "o/r#52", status: "dispatched", process_key: "pp-52", issue_url: "https://github.com/o/r/issues/52" }],
    plan_reviews: [{ plan_key: "o/r#52", epoch: 0, round: 0, approved: 0, findings: "scope too broad", created_at: "2025-01-01T00:00:00.000Z" }],
  });
  const engine = fakeEngine({
    "pp-52": [{ userTaskKey: "ut-plan-completed", elementId: "plan-review-decision", state: "COMPLETED" }],
  });

  await pollUserTasks(data, engine);

  assertEquals(stores.user_tasks ?? [], []);
});
