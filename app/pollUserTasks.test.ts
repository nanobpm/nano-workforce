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
type FakeTask = { userTaskKey: string; elementId?: string; state?: "CREATED" | "COMPLETED" | "CANCELED"; formKey?: string };

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

// ── Engine-first sweep (issue #358) ────────────────────────────────────────────────────────────────
// When the raw-REST surface is available (production always supplies it), the projection's source of
// truth for WHICH escalations are open is the ENGINE, not the tracked subject set: every open escalation
// the engine reports is surfaced — even on an instance NO tracked subject row references (an
// orphaned/untracked instance, the reported 19153 case) — enriched by a subject row when one exists and
// by a per-kind fallback when it does not. These drive the sweep over a stubbed Camunda-8
// `/v2/user-tasks/search`, the raw surface that (unlike the typed `openUserTasks` seam) carries each
// task's `processInstanceKey`.

/** A single task as the raw Camunda-8 `/v2/user-tasks/search` reports it — carries `processInstanceKey`
 *  (the typed seam omits it) so the sweep can map a task back to its subject for enrichment. */
type RawTask = { userTaskKey: string; elementId?: string; processInstanceKey?: string; state?: string; formKey?: string | number | null };

/** Stub `globalThis.fetch` so `pollUserTasks`' engine-first sweep reads its open tasks from `tasks`.
 *  Honours the `page.from`/`page.limit` pagination the sweep drives, and 404s any other path so a stray
 *  call is loud. Returns a restore fn. */
function stubUserTaskSearch(tasks: RawTask[]): () => void {
  const orig = globalThis.fetch;
  // biome-ignore lint/suspicious/noExplicitAny: minimal fetch double for the raw-REST search surface
  globalThis.fetch = (async (url: string | URL, init?: any) => {
    const u = String(url);
    if (!u.endsWith("/user-tasks/search")) return new Response("not found", { status: 404 });
    const body = JSON.parse(init?.body ?? "{}");
    const from: number = body?.page?.from ?? 0;
    const limit: number = body?.page?.limit ?? 100;
    return new Response(JSON.stringify({ items: tasks.slice(from, from + limit) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

const REST = { restAddress: "http://engine.test/v2" };

test("pollUserTasks (engine-first): surfaces an escalation on an UNTRACKED/orphaned instance — the 19153 case (issue #358)", async () => {
  // No `feature_runs`/`plans`/`pull_requests` row references instance 19153, yet the engine reports its
  // `feature-escalation` (key 27337) open. Before #358 the subject-tracking-gated scan dropped it and the
  // operator could never see nor answer it. The engine-first sweep surfaces it, keyed to a stable
  // non-blank fallback subject (the instance) so the row renders and stays answerable.
  const { data, stores } = memData({});
  const restore = stubUserTaskSearch([
    { userTaskKey: "27337", elementId: "feature-escalation", processInstanceKey: "19153", state: "CREATED" },
  ]);
  try {
    await pollUserTasks(data, fakeEngine({}), REST);
  } finally {
    restore();
  }

  const byKey = Object.fromEntries((stores.user_tasks ?? []).map((r) => [r.user_task_key, r]));
  assertEquals(Object.keys(byKey), ["27337"]);
  assertEquals(byKey["27337"].element_id, "feature-escalation");
  assertEquals(byKey["27337"].kind_label, "Feature escalation");
  assertEquals(byKey["27337"].subject_type, "feature");
  assertEquals(byKey["27337"].subject_key, "19153"); // fallback to the instance — non-blank so it renders
  assertEquals(byKey["27337"].subject_title, "19153");
  assertEquals(byKey["27337"].question, null); // no tracked audit source for an orphan → null, still listed
});

test("pollUserTasks (engine-first): orphaned plan-review and PR-wait escalations are surfaced too (issue #358)", async () => {
  // Same failure class across aggregates: a `plan-review-decision` with no `plans` row and a `wait-answer`
  // with no `pull_requests` row are each surfaced, bucketed to the aggregate their kind implies.
  const { data, stores } = memData({});
  const restore = stubUserTaskSearch([
    { userTaskKey: "ut-orphan-plan", elementId: "plan-review-decision", processInstanceKey: "pi-1", state: "CREATED" },
    { userTaskKey: "ut-orphan-pr", elementId: "wait-answer", processInstanceKey: "pi-2", state: "CREATED" },
  ]);
  try {
    await pollUserTasks(data, fakeEngine({}), REST);
  } finally {
    restore();
  }

  const byKey = Object.fromEntries((stores.user_tasks ?? []).map((r) => [r.user_task_key, r]));
  assertEquals(Object.keys(byKey).sort(), ["ut-orphan-plan", "ut-orphan-pr"]);
  assertEquals(byKey["ut-orphan-plan"].subject_type, "plan");
  assertEquals(byKey["ut-orphan-plan"].subject_key, "pi-1");
  assertEquals(byKey["ut-orphan-pr"].subject_type, "pr");
  assertEquals(byKey["ut-orphan-pr"].kind_label, "PR review");
});

test("pollUserTasks (engine-first): a TRACKED task is still fully enriched from its subject row (no regression)", async () => {
  // Enrich, don't gate: when a subject row DOES reference the task's instance, title/url/question come
  // from it exactly as the per-subject scan produced — the sweep maps by `processInstanceKey`.
  const { data, stores } = memData({
    feature_runs: [
      { feature_key: "o/r#10", status: "escalated", process_key: "fp-10", issue_url: "https://github.com/o/r/issues/10", title: "Add the framework selector", delivery_label: null },
    ],
    feature_escalations: [
      { id: 1, feature_key: "o/r#10", question: "which framework?", created_at: "2025-01-01T00:00:00.000Z", job_key: "j1" },
    ],
    plans: [
      { plan_key: "o/r#20", status: "dispatched", process_key: "pp-20", issue_url: "https://github.com/o/r/issues/20", title: "Broaden the epic scope" },
    ],
    plan_reviews: [
      { plan_key: "o/r#20", epoch: 0, round: 1, approved: 0, findings: "scope too broad", created_at: "2025-01-02T00:00:00.000Z" },
    ],
  });
  const restore = stubUserTaskSearch([
    { userTaskKey: "ut-feat", elementId: "feature-escalation", processInstanceKey: "fp-10", state: "CREATED" },
    { userTaskKey: "ut-plan", elementId: "plan-review-decision", processInstanceKey: "pp-20", state: "CREATED" },
  ]);
  try {
    await pollUserTasks(data, fakeEngine({}), REST);
  } finally {
    restore();
  }

  const byKey = Object.fromEntries((stores.user_tasks ?? []).map((r) => [r.user_task_key, r]));
  assertEquals(Object.keys(byKey).sort(), ["ut-feat", "ut-plan"]);
  assertEquals(byKey["ut-feat"].subject_key, "o/r#10");
  assertEquals(byKey["ut-feat"].subject_title, "Add the framework selector");
  assertEquals(byKey["ut-feat"].question, "which framework?");
  assertEquals(byKey["ut-plan"].subject_title, "Broaden the epic scope");
  assertEquals(byKey["ut-plan"].question, "scope too broad");
});

test("pollUserTasks (engine-first): never leaks a non-escalation element nor a non-CREATED task", async () => {
  // The `USER_TASK_KIND_LABELS` gate keeps an arbitrary internal user task out of the inbox, and the
  // defensive state re-filter drops a lagging COMPLETED/CANCELED read (a dead affordance, #294) even if
  // the wire `state` filter is ignored.
  const { data, stores } = memData({});
  const restore = stubUserTaskSearch([
    { userTaskKey: "ut-internal", elementId: "some-internal-task", processInstanceKey: "pi-9", state: "CREATED" },
    { userTaskKey: "ut-done", elementId: "feature-escalation", processInstanceKey: "pi-8", state: "COMPLETED" },
    { userTaskKey: "ut-live", elementId: "feature-escalation", processInstanceKey: "pi-7", state: "CREATED" },
  ]);
  try {
    await pollUserTasks(data, fakeEngine({}), REST);
  } finally {
    restore();
  }

  const keys = (stores.user_tasks ?? []).map((r) => r.user_task_key);
  assertEquals(keys, ["ut-live"]);
});

test("pollUserTasks (engine-first): an answered task (no longer open) is deleted on the next pass", async () => {
  // Feed the engine-derived desired set to the unchanged reconcile: a persisted row whose task the engine
  // no longer reports open is deleted, so `showCount` tracks live work — identical to the scan path.
  const { data, stores } = memData({
    user_tasks: [
      { user_task_key: "ut-gone", element_id: "wait-answer", kind_label: "PR review", subject_type: "pr", subject_key: "o/r#30", subject_url: null, question: null, process_key: "rp-30", created_at: "2025-01-01T00:00:00.000Z", updated_at: "2025-01-01T00:00:00.000Z" },
    ],
  });
  const restore = stubUserTaskSearch([]); // engine reports nothing open
  try {
    await pollUserTasks(data, fakeEngine({}), REST);
  } finally {
    restore();
  }

  assertEquals(stores.user_tasks, []);
});

test("pollUserTasks (engine-first): pages through a large open set (no first-page truncation)", async () => {
  // Open escalations are normally few, but the sweep must page defensively so a large set is not silently
  // truncated to the first page. 150 open escalations across a 100-item page size → all 150 projected.
  const { data, stores } = memData({});
  const tasks: RawTask[] = Array.from({ length: 150 }, (_, i) => ({
    userTaskKey: `ut-${i}`,
    elementId: "feature-escalation",
    processInstanceKey: `pi-${i}`,
    state: "CREATED",
  }));
  const restore = stubUserTaskSearch(tasks);
  try {
    await pollUserTasks(data, fakeEngine({}), REST);
  } finally {
    restore();
  }

  assertEquals((stores.user_tasks ?? []).length, 150);
});
test("pollUserTasks (engine-first): surfaces an inlined delivery-graph human task, enriched + bucketed as `delivery` (issue #442)", async () => {
  // A delivery-graph `human` node is compiled (S4) as an INLINED user task with a per-node id
  // `delivery-human-task__<node>` — the bare `delivery-human-task` never appears at runtime. The poller's
  // leak guards must recognise it through the single-source-of-truth predicate (`userTaskKindLabel` /
  // `isDeliveryHumanElement`), NOT exact `USER_TASK_KIND_LABELS` membership — else every delivery-graph
  // human gate is silently dropped from the Tasks inbox and no operator can tick it off (merlin task 35002).
  const { data, stores } = memData({
    delivery_graph_runs: [
      { run_key: "delivery-graph-403eb22e", process_key: "dg-1", status: "running", title: "release runbook" },
    ],
  });
  const restore = stubUserTaskSearch([
    { userTaskKey: "35002", elementId: "delivery-human-task__n1", processInstanceKey: "dg-1", state: "CREATED" },
  ]);
  try {
    await pollUserTasks(data, fakeEngine({}), REST);
  } finally {
    restore();
  }

  const byKey = Object.fromEntries((stores.user_tasks ?? []).map((r) => [r.user_task_key, r]));
  assertEquals(Object.keys(byKey), ["35002"]);
  assertEquals(byKey["35002"].element_id, "delivery-human-task__n1");
  assertEquals(byKey["35002"].kind_label, "Delivery: human step");
  assertEquals(byKey["35002"].subject_type, "delivery");
  assertEquals(byKey["35002"].subject_key, "delivery-graph-403eb22e");
  assertEquals(byKey["35002"].subject_title, "release runbook");
});

test("pollUserTasks (engine-first): a delivery-human task on an UNTRACKED run still surfaces (bucketed `delivery`, instance fallback) (issue #442)", async () => {
  // Even with no `delivery_graph_runs` row referencing the instance, the kind implies its aggregate, so
  // the row renders and stays answerable — mirroring the orphaned-escalation guarantee (#358).
  const { data, stores } = memData({});
  const restore = stubUserTaskSearch([
    { userTaskKey: "35002", elementId: "delivery-human-task__n1", processInstanceKey: "dg-9", state: "CREATED" },
  ]);
  try {
    await pollUserTasks(data, fakeEngine({}), REST);
  } finally {
    restore();
  }

  const byKey = Object.fromEntries((stores.user_tasks ?? []).map((r) => [r.user_task_key, r]));
  assertEquals(Object.keys(byKey), ["35002"]);
  assertEquals(byKey["35002"].kind_label, "Delivery: human step");
  assertEquals(byKey["35002"].subject_type, "delivery");
  assertEquals(byKey["35002"].subject_key, "dg-9"); // instance fallback — non-blank so it renders
});

test("pollUserTasks (typed-seam fallback): projects an inlined delivery-human task on a RUNNING run, bucketed `delivery` (issue #442)", async () => {
  // The reduced-capability host (no raw-REST surface) discovers open tasks by scanning each active
  // subject's instance through the typed `openUserTasks` seam. A delivery-graph `human` node parks on its
  // RUNNING run's instance, so that instance MUST be scanned here too — else the inlined
  // `delivery-human-task__<node>` gate is dropped on this path even though its leak guard would accept it.
  // Guards the OTHER discovery path the engine-first sweep tests don't reach.
  const { data, stores } = memData({
    delivery_graph_runs: [
      { run_key: "delivery-graph-403eb22e", process_key: "dg-1", status: "running", title: "release runbook" },
      { run_key: "delivery-graph-pending", process_key: null, status: "awaiting-approval", title: "not launched yet" },
    ],
  });
  const engine = fakeEngine({
    "dg-1": [{ userTaskKey: "35002", elementId: "delivery-human-task__n1" }],
  });

  await pollUserTasks(data, engine); // no engineRest → typed-seam fallback

  const byKey = Object.fromEntries((stores.user_tasks ?? []).map((r) => [r.user_task_key, r]));
  assertEquals(Object.keys(byKey), ["35002"]);
  assertEquals(byKey["35002"].element_id, "delivery-human-task__n1");
  assertEquals(byKey["35002"].kind_label, "Delivery: human step");
  assertEquals(byKey["35002"].subject_type, "delivery");
  assertEquals(byKey["35002"].subject_key, "delivery-graph-403eb22e");
  assertEquals(byKey["35002"].subject_title, "release runbook");
});

// ── form_key denormalisation (issue #461) ─────────────────────────────────────────────────────────
// The collapsed Tasks page renders ONE `user_tasks` grid and completes each heterogeneous row via its
// ENGINE-declared form (nano-ide#457). That needs the task's engine `formKey` denormalised onto the
// row so the grid can resolve the deployed `.form` per row. The poller derives it in the SAME canonical
// path it derives `kind_label`: read `formKey` from the `/v2/user-tasks/search` result, falling back to
// `ESCALATION_FORM_BY_ELEMENT` for the fixed-form kinds the search omits it for.

test("pollUserTasks (engine-first): a delivery-graph escalation row is present in the single list AND carries its engine form_key (issue #461)", async () => {
  // The regressed case: an armed delivery-graph run escalated (a bounded service node's timeout twin,
  // dynamic id `delivery-human-task__<node>__esc`) — counted by the `filter: []` badge but rendered by no
  // allowlisted grid. Under the single grid it must (a) surface and (b) be completable via its engine form,
  // so its `formKey` (reported by the engine on the task) is denormalised onto the row.
  const { data, stores } = memData({
    delivery_graph_runs: [
      { run_key: "delivery-graph-407178305d01", process_key: "dg-1", status: "running", title: "ship the release" },
    ],
  });
  const restore = stubUserTaskSearch([
    { userTaskKey: "39354", elementId: "delivery-human-task__n1_task__esc", processInstanceKey: "dg-1", state: "CREATED", formKey: "form-esc-88" },
  ]);
  try {
    await pollUserTasks(data, fakeEngine({}), REST);
  } finally {
    restore();
  }

  const byKey = Object.fromEntries((stores.user_tasks ?? []).map((r) => [r.user_task_key, r]));
  assertEquals(Object.keys(byKey), ["39354"]); // present in the single list
  assertEquals(byKey["39354"].element_id, "delivery-human-task__n1_task__esc");
  assertEquals(byKey["39354"].kind_label, "Delivery: human step");
  assertEquals(byKey["39354"].form_key, "form-esc-88"); // completable via its engine-declared form
});

test("pollUserTasks (engine-first): a fixed-kind escalation whose search omits formKey derives form_key from its .form linkage (issue #461)", async () => {
  // Fallback: the raw search can omit `formKey` for a task; a fixed-form kind's `.form` linkage is a
  // static single source of truth (`ESCALATION_FORM_BY_ELEMENT`), so the row is still completable.
  const { data, stores } = memData({});
  const restore = stubUserTaskSearch([
    { userTaskKey: "ut-plan", elementId: "plan-review-decision", processInstanceKey: "pi-1", state: "CREATED" },
  ]);
  try {
    await pollUserTasks(data, fakeEngine({}), REST);
  } finally {
    restore();
  }

  const byKey = Object.fromEntries((stores.user_tasks ?? []).map((r) => [r.user_task_key, r]));
  assertEquals(byKey["ut-plan"].form_key, "plan-review-decision");
});

test("pollUserTasks (typed-seam fallback): denormalises the engine form_key from the typed openUserTasks seam (issue #461)", async () => {
  const { data, stores } = memData({
    plans: [{ plan_key: "o/r#20", status: "dispatched", process_key: "pp-20", issue_url: null, title: "epic" }],
  });
  const engine = fakeEngine({
    "pp-20": [{ userTaskKey: "ut-plan", elementId: "plan-review-decision", formKey: "form-77" }],
  });

  await pollUserTasks(data, engine); // no engineRest → typed-seam fallback

  const byKey = Object.fromEntries((stores.user_tasks ?? []).map((r) => [r.user_task_key, r]));
  assertEquals(byKey["ut-plan"].form_key, "form-77");
});

test("pollUserTasks (engine-first): self-heals an escalated run stranded off its parked task, sparing a genuinely parked one (issue #642)", async () => {
  // `status="escalated"` must hold ONLY while a `feature-escalation` task is open (parity with the PR
  // contract). A run whose instance the engine no longer reports parked (its escalation was answered,
  // or it predates the write-side reset — the #632 tear) is reconciled to `running`; a run whose task
  // IS still open is left escalated. The engine's open set is the authority, not the raw status column.
  const { data, stores } = memData({
    feature_runs: [
      { feature_key: "o/r#632", status: "escalated", process_key: "fp-632", issue_url: null, title: "stranded", delivery_label: null },
      { feature_key: "o/r#77", status: "escalated", process_key: "fp-77", issue_url: null, title: "still parked", delivery_label: null },
    ],
  });
  const restore = stubUserTaskSearch([
    // Only fp-77 is genuinely parked; the engine reports NO open task on fp-632.
    { userTaskKey: "ut-parked", elementId: "feature-escalation", processInstanceKey: "fp-77", state: "CREATED" },
  ]);
  try {
    await pollUserTasks(data, fakeEngine({ "fp-77": [{ userTaskKey: "ut-parked", elementId: "feature-escalation" }] }), REST);
  } finally {
    restore();
  }

  const byKey = Object.fromEntries((stores.feature_runs ?? []).map((r) => [r.feature_key, r]));
  assertEquals(byKey["o/r#632"].status, "running", "the stranded escalated run is healed to running");
  assertEquals(byKey["o/r#77"].status, "escalated", "the genuinely parked run stays escalated");
});

test("pollUserTasks (engine-first): a TRUNCATED best-effort sweep never heals a genuinely-parked escalated run (issue #642)", async () => {
  // `sweepOpenEscalationTasks` is explicitly best-effort — it BREAKS early on a paging/transport error
  // and projects only what it had gathered. Healing `escalated -> running` on ABSENCE from that partial
  // set is mutating durable state on negative evidence: a genuinely-parked human escalation whose task
  // lived on an unreached page would be silently stolen. The self-heal must confirm per-instance against
  // the engine's authoritative open set, NOT the (possibly truncated) global sweep.
  const { data, stores } = memData({
    feature_runs: [
      { feature_key: "o/r#parked", status: "escalated", process_key: "fp-parked", issue_url: null, title: "genuinely parked", delivery_label: null },
      { feature_key: "o/r#stranded", status: "escalated", process_key: "fp-stranded", issue_url: null, title: "stranded", delivery_label: null },
    ],
  });
  // Page 1 fills the limit (forcing a second page) with unrelated open escalations; page 2 — which WOULD
  // carry fp-parked's escalation — errors, so the sweep truncates and `desired` never sees fp-parked.
  const page1: RawTask[] = Array.from({ length: 100 }, (_, i) => ({
    userTaskKey: `other-${i}`,
    elementId: "feature-escalation",
    processInstanceKey: `other-${i}`,
    state: "CREATED",
  }));
  const orig = globalThis.fetch;
  // biome-ignore lint/suspicious/noExplicitAny: minimal fetch double for the raw-REST search surface
  globalThis.fetch = (async (url: string | URL, init?: any) => {
    if (!String(url).endsWith("/user-tasks/search")) return new Response("not found", { status: 404 });
    const from: number = JSON.parse(init?.body ?? "{}")?.page?.from ?? 0;
    if (from === 0) {
      return new Response(JSON.stringify({ items: page1 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("boom", { status: 500 }); // page 2 transport error -> sweep truncates here
  }) as typeof fetch;
  // The engine's authoritative per-instance open set: fp-parked IS parked; fp-stranded is not.
  const engine = fakeEngine({ "fp-parked": [{ userTaskKey: "ut-parked", elementId: "feature-escalation" }] });
  try {
    await pollUserTasks(data, engine, REST);
  } finally {
    globalThis.fetch = orig;
  }
  const byKey = Object.fromEntries((stores.feature_runs ?? []).map((r) => [r.feature_key, r]));
  assertEquals(byKey["o/r#parked"].status, "escalated", "a genuinely-parked run survives a truncated sweep");
  assertEquals(byKey["o/r#stranded"].status, "running", "a truly stranded run is still healed");
});

test("pollUserTasks (engine-first): does NOT heal an escalated run when the per-instance open-task query errors (issue #642)", async () => {
  // A per-instance query error is not proof the run is unparked — mutating on that negative evidence would
  // again steal a parked escalation. On query error the run must be left `escalated` for a later pass.
  const { data, stores } = memData({
    feature_runs: [{ feature_key: "o/r#err", status: "escalated", process_key: "fp-err", issue_url: null, title: "query errors", delivery_label: null }],
  });
  const restore = stubUserTaskSearch([]); // empty sweep -> old code would heal on absence
  const engine = {
    searchUserTasks: () => Promise.resolve([]),
    openUserTasks: (filter?: { processInstanceKey?: string }) =>
      filter?.processInstanceKey === "fp-err" ? Promise.reject(new Error("engine down")) : Promise.resolve([]),
  } as unknown as EngineClient;
  try {
    await pollUserTasks(data, engine, REST);
  } finally {
    restore();
  }
  const byKey = Object.fromEntries((stores.feature_runs ?? []).map((r) => [r.feature_key, r]));
  assertEquals(byKey["o/r#err"].status, "escalated", "a failed per-instance query leaves the run escalated");
});

test("pollUserTasks (engine-first): does NOT heal a JUST-escalated run inside the grace window before its user task exists (issue #642)", async () => {
  // `record-feature-escalation` writes `status="escalated"` (stamping `updated_at`) on the `escalated`
  // arm IMMEDIATELY BEFORE the engine creates the `feature-escalation` user task. A poll landing in that
  // window sees `openUserTasks` return none and would wrongly flip the fresh escalation back to `running`,
  // making the just-raised escalation invisible. A short grace window on `updated_at` spares a just-written
  // escalation while still healing genuinely-stranded (old) rows.
  const fresh = new Date().toISOString();
  const stale = new Date(Date.now() - 60 * 60_000).toISOString(); // an hour ago — comfortably past grace
  const { data, stores } = memData({
    feature_runs: [
      { feature_key: "o/r#fresh", status: "escalated", process_key: "fp-fresh", updated_at: fresh, issue_url: null, title: "just escalated", delivery_label: null },
      { feature_key: "o/r#old", status: "escalated", process_key: "fp-old", updated_at: stale, issue_url: null, title: "genuinely stranded", delivery_label: null },
    ],
  });
  const restore = stubUserTaskSearch([]); // engine reports no open escalation task for either instance
  const engine = fakeEngine({}); // openUserTasks returns [] for every instance (task not yet created / gone)
  try {
    await pollUserTasks(data, engine, REST);
  } finally {
    restore();
  }
  const byKey = Object.fromEntries((stores.feature_runs ?? []).map((r) => [r.feature_key, r]));
  assertEquals(byKey["o/r#fresh"].status, "escalated", "a just-escalated run inside the grace window is spared the heal");
  assertEquals(byKey["o/r#old"].status, "running", "a genuinely-stranded (old) run is still healed");
});

test("pollUserTasks (typed-seam fallback): self-heals an escalated run with no open feature-escalation task (issue #642)", async () => {
  // The reduced-capability path scans FEATURE_ACTIVE_STATUSES instances (incl. `escalated`) directly,
  // so the per-instance open-task read is just as authoritative for the self-heal.
  const { data, stores } = memData({
    feature_runs: [
      { feature_key: "o/r#632", status: "escalated", process_key: "fp-632", issue_url: null, title: "stranded", delivery_label: null },
    ],
  });
  const engine = fakeEngine({ "fp-632": [] }); // instance active at implement-task, no open user task

  await pollUserTasks(data, engine); // no engineRest → typed-seam fallback

  const byKey = Object.fromEntries((stores.feature_runs ?? []).map((r) => [r.feature_key, r]));
  assertEquals(byKey["o/r#632"].status, "running", "the stranded escalated run is healed to running");
});
