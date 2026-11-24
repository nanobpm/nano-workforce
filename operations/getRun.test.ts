// Tests for GET /app/api/run?key=<key> → operation `getRun` (issue #1054): look up ONE run by key at any
// stage. Headline: a feature run BEFORE its PR opens (absent from /status) is found; the same feature
// once converging carries its convergence-loop PR as a child; a merged (terminal) PR is still found;
// epics and delivery runs resolve; an unknown key is a 404; the shared-secret guard holds.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";
import { withTrackingViews } from "../test/trackingViews.ts";
import handler from "./getRun.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-only dynamic row shapes.
type Row = any;

const T0 = "2026-11-01T00:00:00Z";

function memApp(stores: Record<string, Row[]>, pks: Record<string, string>, vars: Row[] = []): AppApi {
  const table = (name: string) => {
    const rows = stores[name] ?? [];
    const pk = pks[name];
    const match = (where: Record<string, unknown>) => (r: Row) => Object.entries(where).every(([k, v]) => r[k] === v);
    return {
      async all() {
        return rows;
      },
      async find(where: Record<string, unknown> = {}) {
        return rows.filter(match(where));
      },
      async findOne(where: Record<string, unknown>) {
        return rows.find(match(where));
      },
      async get(key: string) {
        return pk ? rows.find((r) => r[pk] === key) : undefined;
      },
    };
  };
  const engine = {
    async searchVariables(q: Record<string, unknown>) {
      return vars.filter((v) => Object.entries(q).every(([k, val]) => v[k] === val));
    },
  };
  return { data: { table: withTrackingViews(table) }, engine, log: noopLog() } as unknown as AppApi;
}

const PKS = {
  feature_runs: "feature_key",
  plans: "plan_key",
  pull_requests: "pr_key",
  delivery_graph_runs: "run_key",
  user_tasks: "user_task_key",
};

function feature(over: Row = {}): Row {
  return {
    feature_key: "o/r#5",
    repo: "o/r",
    issue_number: 5,
    issue_url: "https://github.com/o/r/issues/5",
    title: "Do the thing",
    base_branch: "main",
    status: "running",
    process_key: "proc-f",
    pr_key: null,
    converge: 1,
    auto_merge: 1,
    human_approval: 0,
    auto_resolve_escalations: 0,
    custom_instructions: null,
    acknowledged_at: null,
    created_at: T0,
    updated_at: T0,
    ...over,
  };
}

function pr(over: Row = {}): Row {
  return {
    pr_key: "o/r#9",
    repo: "o/r",
    number: 9,
    url: "https://github.com/o/r/pull/9",
    title: "PR nine",
    status: "converging",
    current_round: 2,
    process_key: "proc-p",
    waiting_since: null,
    merged_at: null,
    active_worker: "w1",
    lease_until: "2026-11-01T01:00:00Z",
    auto_resolve_escalations: 0,
    custom_instructions: 1,
    merge_requested: 1,
    merge_human_approval: 0,
    acknowledged_at: null,
    created_at: T0,
    updated_at: T0,
    ...over,
  };
}

function input(key: string, headers: Record<string, string> = {}) {
  return {
    req: {
      method: "GET",
      path: "/app/api/run",
      query: new URLSearchParams({ key }),
      headers: new Headers(headers),
      text: async () => "",
    } as unknown,
    params: {},
    query: { key },
    body: undefined,
  };
}

test("a feature run BEFORE its PR opens is found, with its settings and readiness gate", async () => {
  const app = memApp({ feature_runs: [feature()] }, PKS, [
    {
      name: "readinessProbes",
      processInstanceKey: "proc-f",
      scopeKey: "proc-f",
      value: JSON.stringify([{ kind: "capability", target: "o/up#1" }]),
    },
  ]);
  const res = (await handler(input("o/r#5"), app)) as Row;
  assertEquals(res.status, 200);
  assertEquals(res.body.kind, "feature");
  assertEquals(res.body.status, "running");
  assertEquals(res.body.processInstanceKey, "proc-f");
  assertEquals(res.body.prUrl, null);
  assertEquals(res.body.children, []);
  assertEquals(res.body.settings.converge, true);
  assertEquals(res.body.settings.autoMerge, true);
  assertEquals(res.body.settings.blockedOn, [{ kind: "capability", target: "o/up#1" }]);
});

test("a converging feature carries its convergence-loop PR as a child, worker/lease and both instance keys", async () => {
  const app = memApp(
    { feature_runs: [feature({ status: "converging", pr_key: "o/r#9" })], pull_requests: [pr()] },
    PKS,
    [{ name: "maxRounds", processInstanceKey: "proc-p", scopeKey: "proc-p", value: "7" }],
  );
  const res = (await handler(input("o/r#5"), app)) as Row;
  assertEquals(res.status, 200);
  assertEquals(res.body.prUrl, "https://github.com/o/r/pull/9");
  assertEquals(res.body.activeWorker, "w1");
  assertEquals(res.body.processInstanceKeys, ["proc-f", "proc-p"]);
  assertEquals(res.body.children.length, 1);
  assertEquals(res.body.children[0].kind, "pr");
  assertEquals(res.body.children[0].status, "converging");
  assertEquals(res.body.children[0].settings.maxRounds, 7);
  assertEquals(res.body.children[0].settings.hasCustomInstructions, true);
  assertEquals(res.body.settings.maxRounds, 7);
});

test("a merged (terminal) PR is still found by key", async () => {
  const app = memApp({ pull_requests: [pr({ status: "merged", merged_at: T0, active_worker: null })] }, PKS);
  const res = (await handler(input("o/r#9"), app)) as Row;
  assertEquals(res.status, 200);
  assertEquals(res.body.kind, "pr");
  assertEquals(res.body.status, "merged");
  assertEquals(res.body.settings.autoMerge, true);
});

test("an epic resolves with its slice PRs as children", async () => {
  const app = memApp(
    {
      plans: [
        {
          plan_key: "o/r#1",
          repo: "o/r",
          title: "Epic",
          status: "dispatched",
          process_key: "proc-e",
          epic_phase: "Implementing",
          auto_merge: 0,
          auto_resolve_escalations: 1,
          acknowledged_at: null,
          created_at: T0,
          updated_at: T0,
        },
      ],
      plan_tasks: [{ id: 1, plan_key: "o/r#1", task_id: "a", pr_key: "o/r#9" }, { id: 2, plan_key: "o/r#1", task_id: "b", pr_key: null }],
      pull_requests: [pr()],
    },
    PKS,
  );
  const res = (await handler(input("o/r#1"), app)) as Row;
  assertEquals(res.status, 200);
  assertEquals(res.body.kind, "epic");
  assertEquals(res.body.stage, "Implementing");
  assertEquals(res.body.settings.autoResolveEscalations, true);
  assertEquals(res.body.children.map((c: Row) => c.key), ["o/r#9"]);
});

test("a delivery-graph run resolves by runKey", async () => {
  const app = memApp(
    {
      delivery_graph_runs: [
        { run_key: "run-abc", title: "G", status: "done", phase: "Done", process_key: "proc-d", auto_resolve_escalations: 0, created_at: T0, updated_at: T0 },
      ],
    },
    PKS,
  );
  const res = (await handler(input("run-abc"), app)) as Row;
  assertEquals(res.status, 200);
  assertEquals(res.body.kind, "delivery");
  assertEquals(res.body.status, "done");
});

test("an unknown key is a 404", async () => {
  const res = (await handler(input("o/r#404"), memApp({}, PKS))) as Row;
  assertEquals(res.status, 404);
});

test("a PR's humanApproval reflects the SUBMITTED setting, surviving approval and the merge handoff", async () => {
  // Submitted gated, approval still outstanding.
  const gated = memApp({ pull_requests: [pr({ merge_human_approval: 1, human_approval_submitted: 1 })] }, PKS);
  assertEquals(((await handler(input("o/r#9"), gated)) as Row).body.settings.humanApproval, true);
  // After approve + startMerge: the loop var is cleared to false and merge_human_approval reset to 0,
  // yet the run was still submitted with humanApproval.
  const merging = memApp(
    { pull_requests: [pr({ status: "merging", merge_requested: 1, merge_human_approval: 0, human_approval_submitted: 1 })] },
    PKS,
    [{ name: "humanApproval", processInstanceKey: "proc-p", scopeKey: "proc-p", value: "false" }],
  );
  assertEquals(((await handler(input("o/r#9"), merging)) as Row).body.settings.humanApproval, true);
  const off = memApp({ pull_requests: [pr({ human_approval_submitted: 0 })] }, PKS);
  assertEquals(((await handler(input("o/r#9"), off)) as Row).body.settings.humanApproval, false);
  // A pre-148 row has no record of the submitted setting: unknown, not a guess.
  const legacy = memApp({ pull_requests: [pr({ merge_human_approval: 0 })] }, PKS);
  assertEquals(((await handler(input("o/r#9"), legacy)) as Row).body.settings.humanApproval, null);
});

test("a feature and an epic for the same issue: the most recently updated run wins", async () => {
  const epic = (updated_at: string) => ({
    plan_key: "o/r#5", repo: "o/r", title: "Epic", status: "dispatched", process_key: "proc-e", epic_phase: "Implementing",
    auto_merge: 0, auto_resolve_escalations: 0, acknowledged_at: null, created_at: T0, updated_at,
  });
  const later = "2026-11-02T00:00:00Z";
  const liveEpic = memApp({ feature_runs: [feature()], plans: [epic(later)] }, PKS);
  assertEquals(((await handler(input("o/r#5"), liveEpic)) as Row).body.kind, "epic");
  const liveFeature = memApp({ feature_runs: [feature({ updated_at: later })], plans: [epic(T0)] }, PKS);
  assertEquals(((await handler(input("o/r#5"), liveFeature)) as Row).body.kind, "feature");
});

test("an operator-cancelled run reads `cancelled` (committed run_cancellations row), an out-of-band terminate stays `abandoned`", async () => {
  const PKX = { ...PKS, run_cancellations: "process_key" };
  const cx = (committed: number) => [{ process_key: "proc-d", run_table: "delivery_graph_runs", cancelled_by: "op", cancel_reason: null, cancelled_at: T0, committed }];
  const run = { run_key: "run-x", title: "G", status: "abandoned", phase: "Running", process_key: "proc-d", auto_resolve_escalations: 0, created_at: T0, updated_at: T0 };
  const cancelled = memApp({ delivery_graph_runs: [run], run_cancellations: cx(1) }, PKX);
  assertEquals(((await handler(input("run-x"), cancelled)) as Row).body.status, "cancelled");
  const provisional = memApp({ delivery_graph_runs: [run], run_cancellations: cx(0) }, PKX);
  assertEquals(((await handler(input("run-x"), provisional)) as Row).body.status, "abandoned");
  const oob = memApp({ delivery_graph_runs: [run] }, PKX);
  assertEquals(((await handler(input("run-x"), oob)) as Row).body.status, "abandoned");
  // Same rule for a feature and an epic.
  const f = memApp({ feature_runs: [feature({ status: "abandoned", process_key: "proc-d" })], run_cancellations: cx(1) }, PKX);
  assertEquals(((await handler(input("o/r#5"), f)) as Row).body.status, "cancelled");
  const e = memApp(
    {
      plans: [{ plan_key: "o/r#5", repo: "o/r", title: "E", status: "abandoned", process_key: "proc-d", epic_phase: null, auto_merge: 0, auto_resolve_escalations: 0, acknowledged_at: null, created_at: T0, updated_at: T0 }],
      run_cancellations: cx(1),
    },
    PKX,
  );
  assertEquals(((await handler(input("o/r#5"), e)) as Row).body.status, "cancelled");
});

test("a feature and an epic sharing an issue key never expose each other's open task", async () => {
  const task = (k: string, subject_type: string, element_id: string, updated_at: string) => ({
    user_task_key: k, element_id, kind_label: "x", subject_type, subject_key: "o/r#5", subject_url: null, question: "q", process_key: "p", created_at: T0, updated_at,
  });
  const later = "2026-11-03T00:00:00Z";
  const epicRow = { plan_key: "o/r#5", repo: "o/r", title: "E", status: "dispatched", process_key: "proc-e", epic_phase: "Implementing", auto_merge: 0, auto_resolve_escalations: 0, acknowledged_at: null, created_at: T0, updated_at: T0 };
  // Feature selected (newer), epic owns the newest task — and an epic task must not drive feature stage.
  const app = memApp(
    {
      feature_runs: [feature({ updated_at: "2026-11-02T00:00:00Z" })],
      plans: [epicRow],
      user_tasks: [task("ut-f", "feature", "feature-escalation", T0), task("ut-e", "plan", "feature-blocked", later)],
    },
    PKS,
  );
  const fb = ((await handler(input("o/r#5"), app)) as Row).body;
  assertEquals(fb.kind, "feature");
  assertEquals(fb.openEscalation.userTaskKey, "ut-f");
  // Epic selected (newer), feature owns the newest task.
  const app2 = memApp(
    {
      feature_runs: [feature()],
      plans: [{ ...epicRow, updated_at: "2026-11-02T00:00:00Z" }],
      user_tasks: [task("ut-f", "feature", "feature-escalation", later), task("ut-e", "plan", "x", T0)],
    },
    PKS,
  );
  const eb = ((await handler(input("o/r#5"), app2)) as Row).body;
  assertEquals(eb.kind, "epic");
  assertEquals(eb.openEscalation.userTaskKey, "ut-e");
});

test("an operator-cancelled PR run reads `cancelled`", async () => {
  const app = memApp(
    {
      pull_requests: [pr({ status: "abandoned" })],
      run_cancellations: [{ process_key: "proc-p", run_table: "pull_requests", cancelled_by: "op", cancel_reason: null, cancelled_at: T0, committed: 1 }],
    },
    { ...PKS, run_cancellations: "process_key" },
  );
  assertEquals(((await handler(input("o/r#9"), app)) as Row).body.status, "cancelled");
});
