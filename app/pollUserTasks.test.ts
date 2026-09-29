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
    // The ADR-0065 derived tracking VIEW (`<base>__tracking`) is modelled as a read-only projection
    // over its base store, augmenting each row with `derived_status` (Copilot review of #829 — the PR
    // self-heal now reads candidates through `prsTracking` and filters on `derived_status="escalated"`).
    // Default `derived_status` to the base `status`, so a fixture that does NOT model out-of-band
    // termination reads live (base status passes through). A test that wants a row the reconciler has
    // already folded terminal seeds an explicit `derived_status` (e.g. `"abandoned"`) on the base row.
    const trackingMatch = /^(.*)__tracking$/.exec(name);
    if (trackingMatch) {
      const base = (stores[trackingMatch[1]] ??= [] as any[]);
      // biome-ignore lint/suspicious/noExplicitAny: see above
      const project = (r: any) => ({ ...r, derived_status: r.derived_status ?? r.status });
      // biome-ignore lint/suspicious/noExplicitAny: see above
      const match = (r: any, where: any) => Object.entries(where).every(([k, v]) => r[k] === v);
      return {
        async all() {
          return base.map(project);
        },
        // biome-ignore lint/suspicious/noExplicitAny: see above
        async get(id: any) {
          const r = base.find((row) => row[pk] === id);
          return r ? project(r) : undefined;
        },
        // biome-ignore lint/suspicious/noExplicitAny: see above
        async find(where: any = {}) {
          return base.map(project).filter((r) => match(r, where));
        },
      };
    }
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
  const data = openableData(stores, tbl);
  return { data, stores };
}

/** Wrap the in-memory `stores` as a `DataLayer` that ALSO exposes `open()` → a `DataSource` with the
 *  `exec` (guarded UPDATE) + `tx` (snapshot/rollback) surface the escalated-PR self-heal now uses for its
 *  conditional, atomic repair (Copilot review of #829). `exec` interprets ONLY the two guarded statements
 *  the heal issues — the snapshot-fenced `pull_requests` CAS and the by-id `escalations` retirement —
 *  mutating the same store objects `table()` reads, so both surfaces stay consistent within a test. The
 *  SQL shape itself is exercised against real SQLite by the app's integration/e2e suites; here the fake
 *  need only honour the guards so a race assertion can observe the CAS refusing a moved snapshot. */
// biome-ignore lint/suspicious/noExplicitAny: in-memory rows are untyped fixtures
function openableData(stores: Record<string, any[]>, tbl: (name: string, pk?: string) => any): DataLayer {
  const norm = (v: unknown) => v ?? null;
  const exec = async (sql: string, params: unknown[] = []) => {
    const flip =
      /UPDATE "pull_requests" SET "status" = 'converging', "updated_at" = \? WHERE "pr_key" = \? AND "status" = 'escalated' AND "process_key" IS \? AND "updated_at" IS \?/.exec(
        sql,
      );
    if (flip) {
      const [at, prKey, processKey, updatedAt] = params;
      const row = (stores.pull_requests ?? []).find((r) => r.pr_key === prKey);
      if (row && row.status === "escalated" && norm(row.process_key) === norm(processKey) && norm(row.updated_at) === norm(updatedAt)) {
        row.status = "converging";
        row.updated_at = at;
        return { changed: 1 };
      }
      return { changed: 0 };
    }
    const retire = /UPDATE "escalations" SET "status" = 'stale' WHERE "id" = \? AND "status" = 'open'/.exec(sql);
    if (retire) {
      const row = (stores.escalations ?? []).find((r) => r.id === params[0]);
      if (row && row.status === "open") {
        row.status = "stale";
        return { changed: 1 };
      }
      return { changed: 0 };
    }
    throw new Error(`unexpected exec sql: ${sql}`);
  };
  const source: any = {
    exec,
    table: (n: string, pk?: string) => tbl(n, pk),
    tx: async (fn: (t: any) => Promise<unknown>) => {
      const snap = JSON.parse(JSON.stringify(stores));
      try {
        return await fn(source);
      } catch (e) {
        for (const [n, rows] of Object.entries(stores)) {
          rows.length = 0;
          rows.push(...(snap[n] ?? []));
        }
        throw e;
      }
    },
  };
  return { table: (n: string, pk?: string) => tbl(n, pk), open: () => source } as unknown as DataLayer;
}

/** A single engine-reported user task in the fixture. `state` mirrors the engine lifecycle; it
 *  defaults to `"CREATED"` (the only open/answerable state) so existing fixtures read as live tasks.
 *  A looping instance holds multiple tasks for one element (COMPLETED from prior rounds + the live one). */
type FakeTask = { userTaskKey: string; elementId?: string; state?: "CREATED" | "COMPLETED" | "CANCELED"; formKey?: string };

/** A single engine-reported element instance in the fixture — the answer-recording service task the
 *  escalation self-heal probes for (issue #829). `state` mirrors the engine lifecycle; `"ACTIVE"` is the
 *  in-flight marker that an answer is being recorded. */
type FakeElement = { elementId: string; state: string };

/** A fake engine whose user tasks are keyed by processInstanceKey (the only field the poller queries on
 *  for plan / PR instances). It models the real engine's two accessors from ONE fixture so a test
 *  genuinely exercises the lifecycle-state filtering: `searchUserTasks` returns tasks in ANY state
 *  (COMPLETED first, as the live API does — issue #294), while `openUserTasks` pins `state:"CREATED"`.
 *  `searchElementInstances` is fed from an OPTIONAL second fixture (default empty) so the PR escalation
 *  self-heal can see an ACTIVE answer-recording task (issue #829). `searchProcessInstances` is fed from an
 *  OPTIONAL third fixture keyed by processInstanceKey: any key NOT listed defaults to reporting the
 *  instance `ACTIVE` (so existing heal fixtures, which model a genuinely-resumed live loop, stay green); a
 *  value of `null` models an instance ABSENT from the read model; a string overrides its lifecycle state
 *  (e.g. `"TERMINATED"`) — the positive-ACTIVE liveness gate the self-heal requires (issue #829). */
function fakeEngine(
  byInstance: Record<string, FakeTask[]>,
  elementsByInstance: Record<string, FakeElement[]> = {},
  instanceStateByInstance: Record<string, string | null> = {},
): EngineClient {
  const all = (filter?: { processInstanceKey?: string }) =>
    filter?.processInstanceKey ? (byInstance[filter.processInstanceKey] ?? []) : [];
  return {
    searchUserTasks: (filter?: { processInstanceKey?: string }) => Promise.resolve(all(filter)),
    openUserTasks: (filter?: { processInstanceKey?: string }) =>
      Promise.resolve(all(filter).filter((t) => (t.state ?? "CREATED") === "CREATED")),
    searchElementInstances: (filter?: { processInstanceKey?: string }) =>
      Promise.resolve(filter?.processInstanceKey ? (elementsByInstance[filter.processInstanceKey] ?? []) : []),
    searchProcessInstances: (filter?: { processInstanceKeys?: string[] }) =>
      Promise.resolve(
        (filter?.processInstanceKeys ?? [])
          .map((k) => {
            const state = k in instanceStateByInstance ? instanceStateByInstance[k] : "ACTIVE";
            return state === null ? null : { processInstanceKey: k, state };
          })
          .filter((it): it is { processInstanceKey: string; state: string } => it != null),
      ),
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

test("pollUserTasks: projects a readiness-escalation-pf preflight task on a feature run (issue #674)", async () => {
  // The leading readiness preflight (feature.bpmn `pf_*` embedded subprocess) parks on the run's OWN
  // engine instance when it times out before its ReadinessProbe goes green. Before #674 the element id
  // was absent from USER_TASK_KIND_LABELS, so `contextFor`'s leak guard dropped it and the parked run
  // was invisible + uncompletable in the Tasks surface. It must now project as an "Upstream readiness
  // stalled" row on the feature subject, carrying the run's wait rollup as the question.
  const { data, stores } = memData({
    feature_runs: [
      {
        feature_key: "o/r#674",
        status: "running",
        process_key: "fp-674",
        issue_url: "https://github.com/o/r/issues/674",
        title: "Ship the widget",
        delivery_label: "waiting on @scope/upstream@1.2.0 · re-checks every 30s",
      },
    ],
  });
  const engine = fakeEngine({ "fp-674": [{ userTaskKey: "ut-readiness-pf", elementId: "readiness-escalation-pf", formKey: "26" }] });

  await pollUserTasks(data, engine);

  const byKey = Object.fromEntries((stores.user_tasks ?? []).map((r) => [r.user_task_key, r]));
  assertEquals(Object.keys(byKey), ["ut-readiness-pf"]);
  assertEquals(byKey["ut-readiness-pf"].element_id, "readiness-escalation-pf");
  assertEquals(byKey["ut-readiness-pf"].kind_label, "Upstream readiness stalled");
  assertEquals(byKey["ut-readiness-pf"].subject_type, "feature");
  assertEquals(byKey["ut-readiness-pf"].subject_key, "o/r#674");
  assertEquals(byKey["ut-readiness-pf"].subject_title, "Ship the widget");
  assertEquals(byKey["ut-readiness-pf"].question, "waiting on @scope/upstream@1.2.0 · re-checks every 30s");
  assertEquals(byKey["ut-readiness-pf"].form_key, "26");
});

test("pollUserTasks: projects a readiness-escalation wait-gate task on a plan, with the wait-gate label as question (issue #674)", async () => {
  // The standalone inter-epic wait-gate cell (readiness-gate.bpmn / wait-gate.bpmn) parks a dependent
  // epic on `readiness-escalation` when its bounded capability wait elapses. It surfaces on the plan
  // subject; the question derivation leans on the wait-gate projection (`plans.wait_gate_label`).
  const { data, stores } = memData({
    plans: [
      {
        plan_key: "o/r#700",
        status: "dispatched",
        process_key: "pp-700",
        issue_url: "https://github.com/o/r/issues/700",
        title: "Dependent epic",
        wait_gate: "escalated",
        wait_gate_label: "escalated · still waiting on @scope/producer@2.0.0 after 24h",
      },
    ],
  });
  const engine = fakeEngine({ "pp-700": [{ userTaskKey: "ut-readiness", elementId: "readiness-escalation" }] });

  await pollUserTasks(data, engine);

  const byKey = Object.fromEntries((stores.user_tasks ?? []).map((r) => [r.user_task_key, r]));
  assertEquals(Object.keys(byKey), ["ut-readiness"]);
  assertEquals(byKey["ut-readiness"].element_id, "readiness-escalation");
  assertEquals(byKey["ut-readiness"].kind_label, "Readiness escalation");
  assertEquals(byKey["ut-readiness"].subject_type, "plan");
  assertEquals(byKey["ut-readiness"].subject_key, "o/r#700");
  assertEquals(byKey["ut-readiness"].question, "escalated · still waiting on @scope/producer@2.0.0 after 24h");
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
type RawTask = { userTaskKey: string; elementId?: string; processInstanceKey?: string; rootProcessInstanceKey?: string | number | null; state?: string; formKey?: string | number | null };

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

test("pollUserTasks (engine-first): a child-cell escalation correlates to its PARENT run via rootProcessInstanceKey (issue #633)", async () => {
  // ADR 0006 S4 (#603/#633): once a slice's implement step runs as a callActivity CHILD cell, the
  // agent-stuck escalation parks on the shared `human-escalation` cell's `escalation` element inside a
  // CHILD instance ("child-pi") whose key NO subject row tracks — the owning feature run is tracked under
  // the PARENT/root instance ("fp-10") the engine reports as `rootProcessInstanceKey`. The poller must
  // correlate the child-instance task back to the parent run (subject + question + kind), not strand it
  // as an orphan keyed to the raw child instance.
  const { data, stores } = memData({
    feature_runs: [
      { feature_key: "o/r#10", status: "escalated", process_key: "fp-10", issue_url: "https://github.com/o/r/issues/10", title: "Add the framework selector", delivery_label: null },
    ],
    feature_escalations: [
      { id: 1, feature_key: "o/r#10", question: "which framework?", created_at: "2025-01-01T00:00:00.000Z", job_key: "j1" },
    ],
  });
  const restore = stubUserTaskSearch([
    { userTaskKey: "ut-child", elementId: "escalation", processInstanceKey: "child-pi", rootProcessInstanceKey: "fp-10", state: "CREATED" },
  ]);
  try {
    await pollUserTasks(data, fakeEngine({}), REST);
  } finally {
    restore();
  }

  const byKey = Object.fromEntries((stores.user_tasks ?? []).map((r) => [r.user_task_key, r]));
  assertEquals(Object.keys(byKey), ["ut-child"]);
  assertEquals(byKey["ut-child"].element_id, "escalation");
  assertEquals(byKey["ut-child"].kind_label, "Feature escalation");
  assertEquals(byKey["ut-child"].subject_type, "feature");
  assertEquals(byKey["ut-child"].subject_key, "o/r#10"); // correlated to the PARENT run, not the child instance
  assertEquals(byKey["ut-child"].subject_title, "Add the framework selector");
  assertEquals(byKey["ut-child"].question, "which framework?"); // same feature_escalations log via the parent subject
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

test("pollUserTasks: a parked delivery-human node carries its instruction as `question` (Decision context, issue #772)", async () => {
  // The Tasks surface seeds no form variables, so a delivery-graph `human` node's instruction can only
  // reach the operator through the read-model `question` (rendered as "Decision context"). Source it
  // from the run's stamped `human_labels`, keyed by the parked user-task element id — else the panel is
  // blank and the human has no idea what the run is waiting on.
  const { data, stores } = memData({
    delivery_graph_runs: [
      {
        run_key: "delivery-graph-403eb22e",
        process_key: "dg-1",
        status: "running",
        title: "release runbook",
        human_labels: JSON.stringify({
          "delivery-human-task__n7": "Run the manual OTP publish for @nanobpm/urban",
        }),
      },
    ],
  });
  const restore = stubUserTaskSearch([
    { userTaskKey: "20411", elementId: "delivery-human-task__n7", processInstanceKey: "dg-1", state: "CREATED" },
    // the bounded-timeout escalation twin parks on the `…__esc` id but resolves the same base label
    { userTaskKey: "20412", elementId: "delivery-human-task__n7__esc", processInstanceKey: "dg-1", state: "CREATED" },
  ]);
  try {
    await pollUserTasks(data, fakeEngine({}), REST);
  } finally {
    restore();
  }

  const byKey = Object.fromEntries((stores.user_tasks ?? []).map((r) => [r.user_task_key, r]));
  assertEquals(byKey["20411"].question, "Run the manual OTP publish for @nanobpm/urban");
  assertEquals(byKey["20412"].question, "Run the manual OTP publish for @nanobpm/urban");
});

test("pollUserTasks: a delivery-human node lifts an embedded prompt URL onto subject_url (issue #813)", async () => {
  // A delivery run carries no other subject URL, so the ONLY clickable link a delivery human task can
  // offer is a URL the author embedded in the node instruction — `deliveryHumanContextUrl` lifts it
  // onto `subject_url`. Assert the wiring end-to-end (pure-helper tests alone would miss a projection
  // regression): the base node AND its bounded-timeout `…__esc` twin both resolve the same stored
  // label to the same link, while a URL-less instruction leaves `subject_url` null.
  const { data, stores } = memData({
    delivery_graph_runs: [
      {
        run_key: "delivery-graph-403eb22e",
        process_key: "dg-1",
        status: "running",
        title: "release runbook",
        human_labels: JSON.stringify({
          "delivery-human-task__n7": "Review the release PR at https://github.com/nanobpm/nano-workforce/pull/814 before publishing.",
          "delivery-human-task__n8": "Run the manual OTP publish for @nanobpm/urban",
        }),
      },
    ],
  });
  const restore = stubUserTaskSearch([
    { userTaskKey: "20411", elementId: "delivery-human-task__n7", processInstanceKey: "dg-1", state: "CREATED" },
    // the bounded-timeout escalation twin parks on the `…__esc` id but resolves the same base link
    { userTaskKey: "20412", elementId: "delivery-human-task__n7__esc", processInstanceKey: "dg-1", state: "CREATED" },
    // a URL-less instruction leaves the link null (no fabricated link)
    { userTaskKey: "20413", elementId: "delivery-human-task__n8", processInstanceKey: "dg-1", state: "CREATED" },
  ]);
  try {
    await pollUserTasks(data, fakeEngine({}), REST);
  } finally {
    restore();
  }

  const byKey = Object.fromEntries((stores.user_tasks ?? []).map((r) => [r.user_task_key, r]));
  assertEquals(byKey["20411"].subject_url, "https://github.com/nanobpm/nano-workforce/pull/814");
  assertEquals(byKey["20412"].subject_url, "https://github.com/nanobpm/nano-workforce/pull/814");
  assertEquals(byKey["20413"].subject_url, null);
});

test("pollUserTasks: a delivery-human node with no stored label still gets a non-blank Decision context (issue #772)", async () => {
  // An untracked run (or a run whose label wasn't stamped) must not leave the panel blank — a static,
  // node-NEUTRAL fallback still tells the operator a delivery-graph step is waiting. It must read true
  // for a non-human escalation twin too, so it must not claim "human step".
  const { data, stores } = memData({});
  const restore = stubUserTaskSearch([
    { userTaskKey: "20411", elementId: "delivery-human-task__n1", processInstanceKey: "dg-9", state: "CREATED" },
    // a bounded `agent`/`wait`/`connector` node's escalation twin: `isDeliveryHumanElement` matches it,
    // but it carries no stored human label, so it gets the neutral fallback, not a "human step" claim.
    { userTaskKey: "20499", elementId: "delivery-human-task__agent5__esc", processInstanceKey: "dg-9", state: "CREATED" },
  ]);
  try {
    await pollUserTasks(data, fakeEngine({}), REST);
  } finally {
    restore();
  }

  const byKey = Object.fromEntries((stores.user_tasks ?? []).map((r) => [r.user_task_key, r]));
  assertEquals(byKey["20411"].question, "A scheduled delivery-graph step is waiting to be completed.");
  assertEquals(byKey["20499"].question, "A scheduled delivery-graph step is waiting to be completed.");
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

test("pollUserTasks (engine-first): skips the per-instance open-task RPC for an escalated run already seen parked in this pass's sweep (issue #642)", async () => {
  // Presence in THIS pass's swept `desired` set is POSITIVE evidence the run is genuinely parked — the
  // best-effort sweep may truncate (drop tasks) but never invents one. Re-confirming such a run with a
  // per-instance `openUserTasks` RPC is a redundant N+1 query on every poll tick; the self-heal must skip
  // it. Only a run NOT confirmed parked by the sweep still needs the per-instance check (unchanged).
  const { data, stores } = memData({
    feature_runs: [
      { feature_key: "o/r#parked", status: "escalated", process_key: "fp-parked", issue_url: null, title: "parked", delivery_label: null },
      { feature_key: "o/r#stranded", status: "escalated", process_key: "fp-stranded", issue_url: null, title: "stranded", delivery_label: null },
    ],
  });
  const restore = stubUserTaskSearch([
    { userTaskKey: "ut-parked", elementId: "feature-escalation", processInstanceKey: "fp-parked", state: "CREATED" },
  ]);
  const openUserTasksCalls: string[] = [];
  const engine = {
    searchUserTasks: () => Promise.resolve([]),
    openUserTasks: (filter?: { processInstanceKey?: string }) => {
      if (filter?.processInstanceKey) openUserTasksCalls.push(filter.processInstanceKey);
      return Promise.resolve([]); // no instance reports an open escalation via the per-instance seam
    },
  } as unknown as EngineClient;
  try {
    await pollUserTasks(data, engine, REST);
  } finally {
    restore();
  }
  const byKey = Object.fromEntries((stores.feature_runs ?? []).map((r) => [r.feature_key, r]));
  assertEquals(byKey["o/r#parked"].status, "escalated", "the swept-parked run stays escalated without a per-instance query");
  assertEquals(byKey["o/r#stranded"].status, "running", "the run absent from the sweep is still confirmed per-instance and healed");
  assertEquals(openUserTasksCalls.includes("fp-parked"), false, "no redundant per-instance RPC for the already-parked run");
  assertEquals(openUserTasksCalls.includes("fp-stranded"), true, "the unconfirmed run still needs the per-instance RPC");
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

test("pollUserTasks (engine-first): does NOT heal an escalated run parked in a callActivity CHILD instance the sweep missed (issue #633)", async () => {
  // A run's escalation can park inside a callActivity CHILD instance on the shared `human-escalation`
  // cell's `escalation` element (ADR 0006 S4, #633), correlated back to the parent run via the root key.
  // When this pass's engine-first sweep is truncated/unavailable, that child task is absent from `desired`,
  // so the run falls through to the per-instance confirmation. Confirming ONLY the parent `process_key`
  // (whose own open tasks are empty — the escalation lives in the CHILD instance) would read "no
  // escalation open" and wrongly flip a genuinely-parked run back to `running`. The confirmation must
  // include the callActivity descendants when the raw-REST surface is available.
  const stale = new Date(Date.now() - 60 * 60_000).toISOString(); // past the heal grace window
  const { data, stores } = memData({
    feature_runs: [
      { feature_key: "o/r#child", status: "escalated", process_key: "fp-parent", updated_at: stale, issue_url: null, title: "parked in child cell", delivery_label: null },
    ],
  });
  // The sweep is unavailable (returns empty), so fp-parent is NOT confirmed parked via `desired`; the
  // descendant walk over `/process-instances/search` surfaces the child instance carrying the escalation.
  const orig = globalThis.fetch;
  // biome-ignore lint/suspicious/noExplicitAny: minimal fetch double for the raw-REST search surfaces
  globalThis.fetch = (async (url: string | URL, init?: any) => {
    const u = String(url);
    if (u.endsWith("/user-tasks/search")) {
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.endsWith("/process-instances/search")) {
      const parent = JSON.parse(init?.body ?? "{}")?.filter?.parentProcessInstanceKey;
      const items = parent === "fp-parent" ? [{ processInstanceKey: "child-1" }] : [];
      return new Response(JSON.stringify({ items }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  // The escalation is parked in the CHILD instance on the `escalation` element, not on the parent.
  const engine = fakeEngine({ "fp-parent": [], "child-1": [{ userTaskKey: "ut-child", elementId: "escalation" }] });
  try {
    await pollUserTasks(data, engine, REST);
  } finally {
    globalThis.fetch = orig;
  }
  const byKey = Object.fromEntries((stores.feature_runs ?? []).map((r) => [r.feature_key, r]));
  assertEquals(byKey["o/r#child"].status, "escalated", "a run parked in a callActivity child cell survives when the sweep missed it");
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

test("pollUserTasks (engine-first): self-heals an escalated PR stranded off its parked task, sparing a genuinely parked one (issue #828)", async () => {
  // The convergence-path twin of the #642 feature heal. A PR's `status="escalated"` must hold ONLY while
  // a `wait-answer` / `wait-merge-answer` task is open. A PR whose instance the engine no longer reports
  // parked (its escalation was answered, but the write-side `answer-escalation` flip was lost around an
  // app restart — the #828 tear) is reconciled to `converging`; a PR whose task IS still open is left
  // escalated. The engine's open set is the authority, not the raw `pull_requests.status` column. The
  // orphaned `open` escalation rows are retired to `stale` so the audit trail matches.
  const { data, stores } = memData({
    pull_requests: [
      { pr_key: "o/r#828", status: "escalated", process_key: "rp-828", url: "https://github.com/o/r/pull/828", title: "stranded" },
      { pr_key: "o/r#77", status: "escalated", process_key: "rp-77", url: "https://github.com/o/r/pull/77", title: "still parked" },
    ],
    escalations: [
      { id: 1, pr_key: "o/r#828", status: "open", question: "orphaned — never answered", answer: null, answered_at: null },
      { id: 2, pr_key: "o/r#77", status: "open", question: "genuinely open", answer: null, answered_at: null },
    ],
  });
  const restore = stubUserTaskSearch([
    // Only rp-77 is genuinely parked; the engine reports NO open task on rp-828.
    { userTaskKey: "ut-parked", elementId: "wait-answer", processInstanceKey: "rp-77", state: "CREATED" },
  ]);
  try {
    await pollUserTasks(data, fakeEngine({ "rp-77": [{ userTaskKey: "ut-parked", elementId: "wait-answer" }] }), REST);
  } finally {
    restore();
  }

  const byKey = Object.fromEntries((stores.pull_requests ?? []).map((r) => [r.pr_key, r]));
  assertEquals(byKey["o/r#828"].status, "converging", "the stranded escalated PR is healed to converging");
  assertEquals(byKey["o/r#77"].status, "escalated", "the genuinely parked PR stays escalated");
  const escById = Object.fromEntries((stores.escalations ?? []).map((r) => [r.id, r]));
  assertEquals(escById[1].status, "stale", "the healed PR's orphaned open escalation row is retired to stale");
  assertEquals(escById[2].status, "open", "the genuinely parked PR's escalation row stays open");
});

test("pollUserTasks (engine-first): self-heals an escalated MERGE-loop PR off its parked wait-merge-answer task (issue #828)", async () => {
  // Both loops write `pr.persist-escalation` (`status="escalated"`) and are answered by the same
  // `answer-escalation` flip, so the heal must confirm against BOTH PR escalation elements — a merge
  // escalation parks on `wait-merge-answer`.
  const { data, stores } = memData({
    pull_requests: [
      { pr_key: "o/r#828m", status: "escalated", process_key: "mp-828", url: "https://github.com/o/r/pull/828", title: "stranded merge" },
    ],
    escalations: [{ id: 1, pr_key: "o/r#828m", status: "open", question: "not mergeable", answer: null, answered_at: null }],
  });
  const restore = stubUserTaskSearch([]); // engine reports NO open task on mp-828
  const engine = fakeEngine({ "mp-828": [] });
  try {
    await pollUserTasks(data, engine, REST);
  } finally {
    restore();
  }
  const byKey = Object.fromEntries((stores.pull_requests ?? []).map((r) => [r.pr_key, r]));
  assertEquals(byKey["o/r#828m"].status, "converging", "the stranded escalated merge-loop PR is healed to converging");
});

test("pollUserTasks (engine-first): does NOT heal an escalated PR while its answer-recording job is in flight (issue #829)", async () => {
  // The dangerous race: both BPMN models flow the completed `wait-answer` / `wait-merge-answer` user task
  // DIRECTLY to the `record-answer` / `record-merge-answer` service task (`pr.answer-escalation`). Between
  // the operator completing the task and that job running, the user task is already gone (openUserTasks
  // returns none) yet the answer is being recorded RIGHT NOW. The escalation can be arbitrarily old (past
  // the raise-time grace), so the grace window does not cover this. Healing here would flip the row to
  // `converging` and retire the still-`open` escalation to `stale`, and the in-flight worker would then
  // find no target and silently drop the operator's answer. An ACTIVE answer-recording element instance is
  // positive evidence the answer is in flight, so the heal must skip it — exactly like an open task.
  const stale = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data, stores } = memData({
    pull_requests: [
      { pr_key: "o/r#829r", status: "escalated", process_key: "rp-829r", updated_at: stale, url: "https://github.com/o/r/pull/829", title: "answer in flight (review)" },
      { pr_key: "o/r#829m", status: "escalated", process_key: "rp-829m", updated_at: stale, url: "https://github.com/o/r/pull/8290", title: "answer in flight (merge)" },
    ],
    escalations: [
      { id: 1, pr_key: "o/r#829r", status: "open", question: "answered, recording", answer: "do it", answered_at: stale },
      { id: 2, pr_key: "o/r#829m", status: "open", question: "answered, recording", answer: "rebase", answered_at: stale },
    ],
  });
  const restore = stubUserTaskSearch([]); // the user task has already completed on both instances
  // Each instance's answer-recording service task is ACTIVE — the operator's answer is being written.
  const engine = fakeEngine(
    { "rp-829r": [], "rp-829m": [] },
    {
      "rp-829r": [{ elementId: "record-answer", state: "ACTIVE" }],
      "rp-829m": [{ elementId: "record-merge-answer", state: "ACTIVE" }],
    },
  );
  try {
    await pollUserTasks(data, engine, REST);
  } finally {
    restore();
  }
  const byKey = Object.fromEntries((stores.pull_requests ?? []).map((r) => [r.pr_key, r]));
  assertEquals(byKey["o/r#829r"].status, "escalated", "a PR with an in-flight review answer-recorder is spared the heal");
  assertEquals(byKey["o/r#829m"].status, "escalated", "a PR with an in-flight merge answer-recorder is spared the heal");
  const escById = Object.fromEntries((stores.escalations ?? []).map((r) => [r.id, r]));
  assertEquals(escById[1].status, "open", "the in-flight review escalation row is left for the worker to answer");
  assertEquals(escById[2].status, "open", "the in-flight merge escalation row is left for the worker to answer");
});

test("pollUserTasks (engine-first): DOES heal an escalated PR once its answer-recorder has completed (issue #829)", async () => {
  // The genuine #828 lost-write tear: the answer-recording job COMPLETED (its element instance is no
  // longer ACTIVE) but the durable `status="converging"` flip was lost around an app restart. With no open
  // task AND no ACTIVE answer-recorder, the PR is genuinely stranded and must heal — the in-flight guard
  // must not over-fire and wedge it permanently.
  const stale = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data, stores } = memData({
    pull_requests: [{ pr_key: "o/r#829c", status: "escalated", process_key: "rp-829c", updated_at: stale, url: "https://github.com/o/r/pull/8291", title: "recorder completed, write lost" }],
    escalations: [{ id: 1, pr_key: "o/r#829c", status: "open", question: "orphaned", answer: null, answered_at: null }],
  });
  const restore = stubUserTaskSearch([]);
  const engine = fakeEngine({ "rp-829c": [] }, { "rp-829c": [{ elementId: "record-answer", state: "COMPLETED" }] });
  try {
    await pollUserTasks(data, engine, REST);
  } finally {
    restore();
  }
  const byKey = Object.fromEntries((stores.pull_requests ?? []).map((r) => [r.pr_key, r]));
  assertEquals(byKey["o/r#829c"].status, "converging", "a stranded PR whose answer-recorder already completed is healed");
  const escById = Object.fromEntries((stores.escalations ?? []).map((r) => [r.id, r]));
  assertEquals(escById[1].status, "stale", "the orphaned open escalation row is retired to stale");
});

test("pollUserTasks (engine-first): does NOT heal an escalated PR whose process instance is TERMINAL (issue #829)", async () => {
  // Copilot review of the #828 heal: "no open task and no ACTIVE escalation element" is ALSO true for a
  // TERMINAL instance (cancelled / completed / failed), whose loop never resumed. Flipping such a frozen
  // `escalated` row to `converging` and retiring its audit rows fabricates a live loop the engine will
  // never advance; terminal PRs are owned by tracking/reconciliation (they read `abandoned`/settled on
  // `derived_status`). The heal now requires POSITIVE engine-truth that the instance is `ACTIVE`, so a
  // TERMINATED (and, below, an absent) instance is spared. One case per known terminal state.
  const stale = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data, stores } = memData({
    pull_requests: [
      { pr_key: "o/r#829tt", status: "escalated", process_key: "rp-829tt", updated_at: stale, url: "https://github.com/o/r/pull/8297", title: "terminated instance" },
      { pr_key: "o/r#829tc", status: "escalated", process_key: "rp-829tc", updated_at: stale, url: "https://github.com/o/r/pull/8298", title: "cancelled instance" },
    ],
    escalations: [
      { id: 1, pr_key: "o/r#829tt", status: "open", question: "loop gone", answer: null, answered_at: null },
      { id: 2, pr_key: "o/r#829tc", status: "open", question: "loop gone", answer: null, answered_at: null },
    ],
  });
  const restore = stubUserTaskSearch([]); // no open task — but the loop is dead, not merely mid-transition
  // No open task, no ACTIVE escalation element, but the instance itself is a known terminal state.
  const engine = fakeEngine(
    { "rp-829tt": [], "rp-829tc": [] },
    {},
    { "rp-829tt": "TERMINATED", "rp-829tc": "CANCELED" },
  );
  try {
    await pollUserTasks(data, engine, REST);
  } finally {
    restore();
  }
  const byKey = Object.fromEntries((stores.pull_requests ?? []).map((r) => [r.pr_key, r]));
  assertEquals(byKey["o/r#829tt"].status, "escalated", "a TERMINATED instance is left to tracking/reconciliation, not healed");
  assertEquals(byKey["o/r#829tc"].status, "escalated", "a CANCELED instance is left to tracking/reconciliation, not healed");
  const escById = Object.fromEntries((stores.escalations ?? []).map((r) => [r.id, r]));
  assertEquals(escById[1].status, "open", "the terminal instance's escalation row is not retired");
  assertEquals(escById[2].status, "open", "the cancelled instance's escalation row is not retired");
});

test("pollUserTasks (engine-first): does NOT heal an escalated PR whose process instance is ABSENT / unknown-state (issue #829)", async () => {
  // The other halves of the tri-state (Copilot review of #828): an instance genuinely ABSENT from the
  // read model (engine answered, no match) is treated like a terminal — its loop is gone, so leave it to
  // tracking rather than fabricate a resumed loop. An instance present with an UNKNOWN/empty `state` is a
  // partial read this app cannot interpret and is SPARED (never healed off a wire shape we misread). Both
  // stay `escalated`. One case each.
  const stale = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data, stores } = memData({
    pull_requests: [
      { pr_key: "o/r#829ab", status: "escalated", process_key: "rp-829ab", updated_at: stale, url: "https://github.com/o/r/pull/8299", title: "absent instance" },
      { pr_key: "o/r#829uk", status: "escalated", process_key: "rp-829uk", updated_at: stale, url: "https://github.com/o/r/pull/82990", title: "unknown-state instance" },
    ],
    escalations: [
      { id: 1, pr_key: "o/r#829ab", status: "open", question: "loop gone", answer: null, answered_at: null },
      { id: 2, pr_key: "o/r#829uk", status: "open", question: "partial read", answer: null, answered_at: null },
    ],
  });
  const restore = stubUserTaskSearch([]);
  // `null` models an instance absent from the read model; a blank string models an unknown/partial state.
  const engine = fakeEngine({ "rp-829ab": [], "rp-829uk": [] }, {}, { "rp-829ab": null, "rp-829uk": "" });
  try {
    await pollUserTasks(data, engine, REST);
  } finally {
    restore();
  }
  const byKey = Object.fromEntries((stores.pull_requests ?? []).map((r) => [r.pr_key, r]));
  assertEquals(byKey["o/r#829ab"].status, "escalated", "an ABSENT instance is left to tracking/reconciliation, not healed");
  assertEquals(byKey["o/r#829uk"].status, "escalated", "an UNKNOWN-state instance is spared, not healed off a misread wire shape");
  const escById = Object.fromEntries((stores.escalations ?? []).map((r) => [r.id, r]));
  assertEquals(escById[1].status, "open", "the absent instance's escalation row is not retired");
  assertEquals(escById[2].status, "open", "the unknown-state instance's escalation row is not retired");
});

test("pollUserTasks (engine-first): a terminated-while-escalated PR is EXCLUDED by the derived tracking VIEW — never probed (issue #829)", async () => {
  // Copilot review of #829: the candidate scan reads through `prsTracking` and requires
  // `derived_status="escalated"`, so a PR TERMINATED while its base status was `escalated` — whose VIEW
  // folds `derived_status` to `abandoned` — is excluded BEFORE any per-instance probe. Without the VIEW
  // filter this historical row would be reselected every poll and burn engine RPCs forever. We seed an
  // explicit `derived_status: "abandoned"` (the reconciler's terminal fold) and assert the heal issues NO
  // engine RPC for it at all, and its frozen base row / escalation are left untouched.
  const stale = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data, stores } = memData({
    pull_requests: [
      { pr_key: "o/r#829term", status: "escalated", derived_status: "abandoned", process_key: "rp-829term", updated_at: stale, url: "https://github.com/o/r/pull/82991", title: "terminated-while-escalated (VIEW-folded)" },
    ],
    escalations: [{ id: 1, pr_key: "o/r#829term", status: "open", question: "loop gone", answer: null, answered_at: null }],
  });
  const restore = stubUserTaskSearch([]);
  const probed: string[] = [];
  const engine = {
    searchUserTasks: () => Promise.resolve([]),
    openUserTasks: (f?: { processInstanceKey?: string }) => {
      if (f?.processInstanceKey) probed.push(f.processInstanceKey);
      return Promise.resolve([]);
    },
    searchElementInstances: (f?: { processInstanceKey?: string }) => {
      if (f?.processInstanceKey) probed.push(f.processInstanceKey);
      return Promise.resolve([]);
    },
    searchProcessInstances: (f?: { processInstanceKeys?: string[] }) => {
      for (const k of f?.processInstanceKeys ?? []) probed.push(k);
      return Promise.resolve([]);
    },
  } as unknown as EngineClient;
  try {
    await pollUserTasks(data, engine, REST);
  } finally {
    restore();
  }
  assertEquals(probed.includes("rp-829term"), false, "a VIEW-folded terminal row is excluded from the scan — no engine RPC is issued for it");
  const byKey = Object.fromEntries((stores.pull_requests ?? []).map((r) => [r.pr_key, r]));
  assertEquals(byKey["o/r#829term"].status, "escalated", "the terminated row's frozen base status is left to tracking, not rewritten");
  const escById = Object.fromEntries((stores.escalations ?? []).map((r) => [r.id, r]));
  assertEquals(escById[1].status, "open", "the terminated row's escalation is not retired");
});

test("pollUserTasks (engine-first): does NOT heal an escalated PR while its persist-escalation producer is still ACTIVE (issue #829)", async () => {
  // The producer-side twin of the answer-recorder race. `pr.persist-escalation` COMMITS the `open` row and
  // `status="escalated"` BEFORE the engine creates the `wait-answer` user task, so there is a window with an
  // `escalated` PR, an `open` escalation, and NO user task yet. The raise-time grace normally covers it, but
  // if the producer service task stays ACTIVE past the grace (an app restart / lease delay between the DB
  // commit and the job completing) the row is old enough to heal while the escalation is being raised RIGHT
  // NOW. Healing here would retire the just-raised escalation to `stale` and the question would never surface.
  // An ACTIVE persist-escalation element is positive evidence, so the heal must skip it — one case per loop.
  const stale = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data, stores } = memData({
    pull_requests: [
      { pr_key: "o/r#829pr", status: "escalated", process_key: "rp-829pr", updated_at: stale, url: "https://github.com/o/r/pull/8293", title: "producer active (review)" },
      { pr_key: "o/r#829pm", status: "escalated", process_key: "rp-829pm", updated_at: stale, url: "https://github.com/o/r/pull/8294", title: "producer active (merge)" },
    ],
    escalations: [
      { id: 1, pr_key: "o/r#829pr", status: "open", question: "being raised", answer: null, answered_at: null },
      { id: 2, pr_key: "o/r#829pm", status: "open", question: "being raised", answer: null, answered_at: null },
    ],
  });
  const restore = stubUserTaskSearch([]); // the user task does not exist yet — the producer hasn't completed
  const engine = fakeEngine(
    { "rp-829pr": [], "rp-829pm": [] },
    {
      "rp-829pr": [{ elementId: "persist-escalation-blockedcomments", state: "ACTIVE" }],
      "rp-829pm": [{ elementId: "merge-esc-conflict", state: "ACTIVE" }],
    },
  );
  try {
    await pollUserTasks(data, engine, REST);
  } finally {
    restore();
  }
  const byKey = Object.fromEntries((stores.pull_requests ?? []).map((r) => [r.pr_key, r]));
  assertEquals(byKey["o/r#829pr"].status, "escalated", "a PR with an ACTIVE review persist-escalation producer is spared the heal");
  assertEquals(byKey["o/r#829pm"].status, "escalated", "a PR with an ACTIVE merge persist-escalation producer is spared the heal");
  const escById = Object.fromEntries((stores.escalations ?? []).map((r) => [r.id, r]));
  assertEquals(escById[1].status, "open", "the just-raised review escalation row is left open");
  assertEquals(escById[2].status, "open", "the just-raised merge escalation row is left open");
});

test("pollUserTasks (engine-first): does NOT heal an escalated PR when the producer→user-task transition lands BETWEEN the two engine reads (issue #829)", async () => {
  // The producer→user-task TOCTOU the prior two guards miss. `openUserTasks()` (read 1) returns empty while
  // a long-running persist producer is still ACTIVE; that producer then COMPLETES and the engine creates the
  // `wait-answer` / `wait-merge-answer` user task BEFORE `searchElementInstances()` (read 2). Read 2 therefore
  // sees an ACTIVE wait element — NOT the producer. Because user-task creation does not re-stamp the PR row's
  // `updated_at` (only `pr.persist-escalation` does, before the task exists), the row is past the raise-time
  // grace, so neither the grace nor the producer/answer-recorder predicate covers it: a predicate that ignores
  // the wait elements lets the CAS win and stale a live escalation. Treat an ACTIVE `wait-answer` /
  // `wait-merge-answer` element as positive evidence in the second snapshot too — one case per loop.
  const stale = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data, stores } = memData({
    pull_requests: [
      { pr_key: "o/r#829wr", status: "escalated", process_key: "rp-829wr", updated_at: stale, url: "https://github.com/o/r/pull/8295", title: "producer→wait (review)" },
      { pr_key: "o/r#829wm", status: "escalated", process_key: "rp-829wm", updated_at: stale, url: "https://github.com/o/r/pull/8296", title: "producer→wait (merge)" },
    ],
    escalations: [
      { id: 1, pr_key: "o/r#829wr", status: "open", question: "raised mid-read", answer: null, answered_at: null },
      { id: 2, pr_key: "o/r#829wm", status: "open", question: "raised mid-read", answer: null, answered_at: null },
    ],
  });
  // The typed `openUserTasks` seam reports NO open task (the producer was still ACTIVE at read 1), while the
  // element search (read 2) now sees the freshly-created wait element ACTIVE — the transition landed mid-read.
  const restore = stubUserTaskSearch([]);
  const engine = fakeEngine(
    { "rp-829wr": [], "rp-829wm": [] },
    {
      "rp-829wr": [{ elementId: "wait-answer", state: "ACTIVE" }],
      "rp-829wm": [{ elementId: "wait-merge-answer", state: "ACTIVE" }],
    },
  );
  try {
    await pollUserTasks(data, engine, REST);
  } finally {
    restore();
  }
  const byKey = Object.fromEntries((stores.pull_requests ?? []).map((r) => [r.pr_key, r]));
  assertEquals(byKey["o/r#829wr"].status, "escalated", "a PR whose wait-answer appeared mid-read is spared the heal");
  assertEquals(byKey["o/r#829wm"].status, "escalated", "a PR whose wait-merge-answer appeared mid-read is spared the heal");
  const escById = Object.fromEntries((stores.escalations ?? []).map((r) => [r.id, r]));
  assertEquals(escById[1].status, "open", "the live review escalation row is left open");
  assertEquals(escById[2].status, "open", "the live merge escalation row is left open");
});

test("pollUserTasks (engine-first): a re-escalation in the read→write window is NOT clobbered — the guarded CAS refuses the moved snapshot (issue #829)", async () => {
  // The TOCTOU race Copilot flagged: the heal reads the PR, then does two remote engine RPCs, THEN writes.
  // If the SAME instance re-escalates in that window (`pr.persist-escalation` re-stamps `updated_at` and
  // INSERTs a fresh open escalation), a blind write would clobber the fresh `escalated` status and stale
  // the fresh escalation — dropping the operator's next answer. We reproduce the concurrent re-escalation
  // by mutating the store from inside `searchElementInstances` (the last read before the write), then
  // assert the snapshot-fenced CAS makes NO change: the PR stays `escalated` and the fresh escalation open.
  // NB the mutation advances `updated_at` AND inserts the fresh escalation TOGETHER, modelling the now-atomic
  // `pr.persist-escalation` producer (its insert + PR re-stamp share one transaction, issue #829) — so a
  // captured snapshot can never see the new escalation under the OLD generation; the covering red/green for
  // that producer atomicity lives in app/persist-escalation.test.ts.
  const stale = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data, stores } = memData({
    pull_requests: [{ pr_key: "o/r#829race", status: "escalated", process_key: "rp-829race", updated_at: stale, url: "https://github.com/o/r/pull/8292", title: "re-escalates mid-heal" }],
    escalations: [{ id: 1, pr_key: "o/r#829race", status: "open", question: "first", answer: null, answered_at: null }],
  });
  const restore = stubUserTaskSearch([]);
  let reEscalated = false;
  const engine = {
    searchUserTasks: () => Promise.resolve([]),
    openUserTasks: () => Promise.resolve([]),
    // Report the instance ACTIVE so the heal reaches its guarded CAS (Copilot review of #829): without a
    // `searchProcessInstances` response the positive-liveness probe throws, sets `queryErrored`, and the
    // row would be spared for the WRONG reason — never exercising the snapshot-fenced CAS this test asserts.
    searchProcessInstances: () => Promise.resolve([{ processInstanceKey: "rp-829race", state: "ACTIVE" }]),
    searchElementInstances: (filter?: { processInstanceKey?: string }) => {
      // Simulate the concurrent re-escalation landing AFTER the heal captured its snapshot but BEFORE its
      // write: the row's generation advances (`updated_at`) and a brand-new open escalation is inserted.
      if (filter?.processInstanceKey === "rp-829race" && !reEscalated) {
        reEscalated = true;
        const row = (stores.pull_requests ?? []).find((r) => r.pr_key === "o/r#829race");
        if (row) row.updated_at = new Date().toISOString();
        (stores.escalations ?? []).push({ id: 2, pr_key: "o/r#829race", status: "open", question: "second", answer: null, answered_at: null });
      }
      return Promise.resolve([{ elementId: "record-answer", state: "COMPLETED" }]);
    },
  } as unknown as EngineClient;
  try {
    await pollUserTasks(data, engine, REST);
  } finally {
    restore();
  }
  const byKey = Object.fromEntries((stores.pull_requests ?? []).map((r) => [r.pr_key, r]));
  assertEquals(byKey["o/r#829race"].status, "escalated", "the re-escalated PR is left escalated — the CAS refused the moved snapshot");
  const escById = Object.fromEntries((stores.escalations ?? []).map((r) => [r.id, r]));
  assertEquals(escById[2].status, "open", "the fresh escalation opened in the window is NOT retired");
  assertEquals(escById[1].status, "open", "the snapshot's own escalation is left untouched too — the whole tx rolled to a no-op");
});

test("pollUserTasks (engine-first): skips the per-instance open-task RPC for an escalated PR already seen parked in this pass's sweep (issue #828)", async () => {
  // best-effort sweep may truncate (drop tasks) but never invents one. Re-confirming with a per-instance
  // `openUserTasks` RPC is a redundant N+1 query; the self-heal must skip it. Only a PR NOT confirmed
  // parked by the sweep still needs the per-instance check.
  const { data, stores } = memData({
    pull_requests: [
      { pr_key: "o/r#parked", status: "escalated", process_key: "rp-parked", url: "https://github.com/o/r/pull/1", title: "parked" },
      { pr_key: "o/r#stranded", status: "escalated", process_key: "rp-stranded", url: "https://github.com/o/r/pull/2", title: "stranded" },
    ],
    escalations: [{ id: 1, pr_key: "o/r#parked", status: "open", question: "open", answer: null, answered_at: null }],
  });
  const restore = stubUserTaskSearch([
    { userTaskKey: "ut-parked", elementId: "wait-answer", processInstanceKey: "rp-parked", state: "CREATED" },
  ]);
  const openUserTasksCalls: string[] = [];
  const engine = {
    searchUserTasks: () => Promise.resolve([]),
    openUserTasks: (filter?: { processInstanceKey?: string }) => {
      if (filter?.processInstanceKey) openUserTasksCalls.push(filter.processInstanceKey);
      return Promise.resolve([]);
    },
    searchElementInstances: () => Promise.resolve([]),
    // The stranded instance genuinely resumed (ACTIVE) — so the sweep-miss falls through to the
    // per-instance confirm AND the positive-liveness gate, and heals (issue #829).
    searchProcessInstances: (filter?: { processInstanceKeys?: string[] }) =>
      Promise.resolve((filter?.processInstanceKeys ?? []).map((k) => ({ processInstanceKey: k, state: "ACTIVE" }))),
  } as unknown as EngineClient;
  try {
    await pollUserTasks(data, engine, REST);
  } finally {
    restore();
  }
  const byKey = Object.fromEntries((stores.pull_requests ?? []).map((r) => [r.pr_key, r]));
  assertEquals(byKey["o/r#parked"].status, "escalated", "the swept-parked PR stays escalated without a per-instance query");
  assertEquals(byKey["o/r#stranded"].status, "converging", "the PR absent from the sweep is still confirmed per-instance and healed");
  assertEquals(openUserTasksCalls.includes("rp-parked"), false, "no redundant per-instance RPC for the already-parked PR");
  assertEquals(openUserTasksCalls.includes("rp-stranded"), true, "the unconfirmed PR still needs the per-instance RPC");
});

test("pollUserTasks (engine-first): does NOT heal an escalated PR when the per-instance open-task query errors (issue #828)", async () => {
  // A per-instance query error is not proof the PR is unparked — mutating on that negative evidence would
  // steal a parked escalation. On query error the PR must be left `escalated` for a later pass.
  const { data, stores } = memData({
    pull_requests: [{ pr_key: "o/r#err", status: "escalated", process_key: "rp-err", url: "https://github.com/o/r/pull/9", title: "query errors" }],
    escalations: [{ id: 1, pr_key: "o/r#err", status: "open", question: "open", answer: null, answered_at: null }],
  });
  const restore = stubUserTaskSearch([]);
  const engine = {
    searchUserTasks: () => Promise.resolve([]),
    openUserTasks: (filter?: { processInstanceKey?: string }) =>
      filter?.processInstanceKey === "rp-err" ? Promise.reject(new Error("engine down")) : Promise.resolve([]),
    searchElementInstances: () => Promise.resolve([]),
  } as unknown as EngineClient;
  try {
    await pollUserTasks(data, engine, REST);
  } finally {
    restore();
  }
  const byKey = Object.fromEntries((stores.pull_requests ?? []).map((r) => [r.pr_key, r]));
  assertEquals(byKey["o/r#err"].status, "escalated", "a failed per-instance query leaves the PR escalated");
  const escById = Object.fromEntries((stores.escalations ?? []).map((r) => [r.id, r]));
  assertEquals(escById[1].status, "open", "the escalation row is untouched when the heal is skipped");
});

test("pollUserTasks (engine-first): does NOT heal a JUST-escalated PR inside the grace window before its user task exists (issue #828)", async () => {
  // `pr.persist-escalation` stamps `status="escalated"` (and `updated_at`) IMMEDIATELY BEFORE the engine
  // creates the `wait-answer` user task. A poll landing in that window sees `openUserTasks` return none
  // and would wrongly flip the fresh escalation back to `converging`. A short grace window on `updated_at`
  // spares a just-written escalation while still healing genuinely-stranded (old) rows.
  const fresh = new Date().toISOString();
  const stale = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data, stores } = memData({
    pull_requests: [
      { pr_key: "o/r#fresh", status: "escalated", process_key: "rp-fresh", updated_at: fresh, url: "https://github.com/o/r/pull/3", title: "just escalated" },
      { pr_key: "o/r#old", status: "escalated", process_key: "rp-old", updated_at: stale, url: "https://github.com/o/r/pull/4", title: "genuinely stranded" },
    ],
    escalations: [
      { id: 1, pr_key: "o/r#fresh", status: "open", question: "fresh", answer: null, answered_at: null },
      { id: 2, pr_key: "o/r#old", status: "open", question: "old", answer: null, answered_at: null },
    ],
  });
  const restore = stubUserTaskSearch([]);
  const engine = fakeEngine({});
  try {
    await pollUserTasks(data, engine, REST);
  } finally {
    restore();
  }
  const byKey = Object.fromEntries((stores.pull_requests ?? []).map((r) => [r.pr_key, r]));
  assertEquals(byKey["o/r#fresh"].status, "escalated", "a just-escalated PR inside the grace window is spared the heal");
  assertEquals(byKey["o/r#old"].status, "converging", "a genuinely-stranded (old) PR is still healed");
});
