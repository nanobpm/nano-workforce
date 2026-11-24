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
