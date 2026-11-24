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
  // A pre-152 row has no record of the submitted setting: unknown, not a guess.
  const legacy = memApp({ pull_requests: [pr({ merge_human_approval: 0 })] }, PKS);
  assertEquals(((await handler(input("o/r#9"), legacy)) as Row).body.settings.humanApproval, null);
});

test("a feature and an epic for the same issue: the live run wins, else the newest-created", async () => {
  const epic = (over: Row = {}) => ({
    plan_key: "o/r#5", repo: "o/r", title: "Epic", status: "dispatched", process_key: "proc-e", epic_phase: "Implementing",
    auto_merge: 0, auto_resolve_escalations: 0, acknowledged_at: null, created_at: T0, updated_at: T0, ...over,
  });
  const later = "2026-11-02T00:00:00Z";
  const newerEpic = memApp({ feature_runs: [feature()], plans: [epic({ created_at: later })] }, PKS);
  assertEquals(((await handler(input("o/r#5"), newerEpic)) as Row).body.kind, "epic");
  const newerFeature = memApp({ feature_runs: [feature({ created_at: later })], plans: [epic()] }, PKS);
  assertEquals(((await handler(input("o/r#5"), newerFeature)) as Row).body.kind, "feature");
  // updated_at never decides: a bumped (e.g. phase-polled) epic does not shadow a same-age feature.
  const bumped = memApp({ feature_runs: [feature()], plans: [epic({ updated_at: later })] }, PKS);
  assertEquals(((await handler(input("o/r#5"), bumped)) as Row).body.kind, "feature");
  // A terminal, acknowledged (updated_at-stamped) feature never shadows a live epic.
  const acked = memApp(
    { feature_runs: [feature({ status: "merged", acknowledged_at: later, updated_at: later, created_at: later })], plans: [epic()] },
    PKS,
  );
  assertEquals(((await handler(input("o/r#5"), acked)) as Row).body.kind, "epic");
  // A FINISHED raise-only feature (`opened`, converge=0) is terminal: it never shadows an older live
  // epic, and a newer terminal epic beats it on created_at (featureDismissableTerminal parity).
  const raiseOnly = { status: "opened", converge: 0, pr_key: "o/r#6" };
  const raisedVsLive = memApp({ feature_runs: [feature({ ...raiseOnly, created_at: later })], plans: [epic()] }, PKS);
  assertEquals(((await handler(input("o/r#5"), raisedVsLive)) as Row).body.kind, "epic");
  const raisedVsNewerDone = memApp({ feature_runs: [feature(raiseOnly)], plans: [epic({ status: "done", created_at: later })] }, PKS);
  assertEquals(((await handler(input("o/r#5"), raisedVsNewerDone)) as Row).body.kind, "epic");
  // ...but a mid-handoff `opened` (converge=1 with a PR) is still live and wins over an older live epic.
  const handoff = memApp({ feature_runs: [feature({ status: "opened", converge: 1, pr_key: "o/r#6", created_at: later })], plans: [epic({ status: "done" })] }, PKS);
  assertEquals(((await handler(input("o/r#5"), handoff)) as Row).body.kind, "feature");
  // Key resolution uses the SAME rolled-up feature terminal as the view: a feature row lagging at
  // `converging` whose child PR already merged (or was cancelled) is finished and never shadows an
  // older live epic, even though it is newer.
  const cancelled = { process_key: "proc-p", run_table: "x", cancelled_by: "op", cancel_reason: null, cancelled_at: T0, committed: 1 };
  const cases: [string, Row, Row[]][] = [
    ["merged", { status: "merged", merged_at: T0, active_worker: null }, []],
    ["cancelled", { status: "abandoned", active_worker: null }, [cancelled]],
  ];
  for (const [label, prOver, cancellations] of cases) {
    const lagging = memApp(
      {
        feature_runs: [feature({ status: "converging", pr_key: "o/r#9", created_at: later })],
        pull_requests: [pr(prOver)],
        plans: [epic()],
        run_cancellations: cancellations,
      },
      { ...PKS, run_cancellations: "process_key" },
    );
    assertEquals(((await handler(input("o/r#5"), lagging)) as Row).body.kind, "epic", label);
  }
});

test("a live epic parked on its readiness wait surfaces the gate as stage + blockedOn", async () => {
  const app = memApp(
    {
      plans: [{ plan_key: "o/r#5", repo: "o/r", title: "E", status: "dispatched", process_key: "proc-e", epic_phase: "Implementing", wait_gate: "waiting", wait_gate_label: "Waiting on o/p capability", auto_merge: 0, auto_resolve_escalations: 0, acknowledged_at: null, created_at: T0, updated_at: T0 }],
    },
    PKS,
  );
  const b = ((await handler(input("o/r#5"), app)) as Row).body;
  assertEquals(b.stage, "Waiting on o/p capability");
  assertEquals(b.settings.blockedOn, [{ waitGate: "waiting", label: "Waiting on o/p capability" }]);
});

test("a cancelled PR run and a cancelled delivery run with a stale incident_key read `cancelled`", async () => {
  const PKX = { ...PKS, run_cancellations: "process_key" };
  const cx = (pk: string) => ({ process_key: pk, run_table: "x", cancelled_by: "op", cancel_reason: null, cancelled_at: T0, committed: 1 });
  const inc = { incident_key: "inc-1", incident_since: T0, incident_message: "boom", incident_element: "x" };
  const prApp = memApp({ pull_requests: [pr({ status: "abandoned", ...inc })], run_cancellations: [cx("proc-p")] }, PKX);
  const pb = ((await handler(input("o/r#9"), prApp)) as Row).body;
  assertEquals(pb.status, "cancelled");
  assertEquals(pb.incident, null);
  const run = { run_key: "run-x", title: "G", status: "abandoned", phase: "Running", process_key: "proc-d", auto_resolve_escalations: 0, created_at: T0, updated_at: T0, ...inc };
  const dApp = memApp({ delivery_graph_runs: [run], run_cancellations: [cx("proc-d")] }, PKX);
  const db = ((await handler(input("run-x"), dApp)) as Row).body;
  assertEquals(db.status, "cancelled");
  assertEquals(db.incident, null);
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
  const fb = ((await handler(input("o/r#5"), f)) as Row).body;
  assertEquals(fb.status, "cancelled");
  assertEquals(fb.stage, "Done");
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
  // Feature selected (newer-created), epic owns the newest task — and an epic task must not drive feature stage.
  const app = memApp(
    {
      feature_runs: [feature({ created_at: "2026-11-02T00:00:00Z" })],
      plans: [epicRow],
      user_tasks: [task("ut-f", "feature", "feature-escalation", T0), task("ut-e", "plan", "feature-blocked", later)],
    },
    PKS,
  );
  const fb = ((await handler(input("o/r#5"), app)) as Row).body;
  assertEquals(fb.kind, "feature");
  assertEquals(fb.openEscalation.userTaskKey, "ut-f");
  // Epic selected (newer-created), feature owns the newest task.
  const app2 = memApp(
    {
      feature_runs: [feature()],
      plans: [{ ...epicRow, created_at: "2026-11-02T00:00:00Z" }],
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

test("a feature delegating to its PR reads the PR's rollup status and a `terminal` flag (never status strings)", async () => {
  const look = async (f: Row, p: Row) => ((await handler(input("o/r#5"), memApp({ feature_runs: [f], pull_requests: [p] }, PKS))) as Row).body;
  // Mid-handoff `opened` (converge=1 with a pr_key) is NOT terminal while the PR still converges.
  const mid = await look(feature({ status: "opened", pr_key: "o/r#9" }), pr());
  assertEquals(mid.status, "converging");
  assertEquals(mid.terminal, false);
  // The feature row lags (still `converging`) but its PR merged: the lookup reads `merged`, terminal.
  const merged = await look(feature({ status: "converging", pr_key: "o/r#9" }), pr({ status: "merged", merged_at: T0 }));
  assertEquals(merged.status, "merged");
  assertEquals(merged.terminal, true);
  assertEquals(merged.children[0].terminal, true);
  // A PR in a merge-to-convergence handoff (`waiting_review`) is not terminal.
  const handoff = await look(feature({ status: "converging", pr_key: "o/r#9" }), pr({ status: "waiting_review" }));
  assertEquals(handoff.terminal, false);
  assertEquals(handoff.children[0].terminal, false);
  // A raise-only finished `opened` (converge=0) stays terminal.
  const raised = await look(feature({ status: "opened", converge: 0, pr_key: "o/r#9" }), pr());
  assertEquals(raised.status, "opened");
  assertEquals(raised.terminal, true);
});

test("a closed or failed PR is terminal (the canonical PR terminal set, not the epic-delivery one)", async () => {
  for (const status of ["closed", "failed"]) {
    const app = memApp({ pull_requests: [pr({ status })] }, PKS);
    const body = ((await handler(input("o/r#9"), app)) as Row).body;
    assertEquals(body.terminal, true, status);
    assertEquals(body.incident, null, status);
  }
});

test("a delegating feature's stage derives from the same rolled-up basis as its terminal flag", async () => {
  const look = async (f: Row, p: Row) => ((await handler(input("o/r#5"), memApp({ feature_runs: [f], pull_requests: [p] }, PKS))) as Row).body;
  const lagging = await look(feature({ status: "converging", pr_key: "o/r#9" }), pr({ status: "merged", merged_at: T0 }));
  const mid = await look(feature({ status: "opened", pr_key: "o/r#9" }), pr({ status: "merged", merged_at: T0 }));
  const done = await look(feature({ status: "merged", pr_key: "o/r#9" }), pr({ status: "merged", merged_at: T0 }));
  assertEquals(lagging.stage, done.stage);
  assertEquals(mid.stage, done.stage);
  assertEquals(lagging.terminal, true);
});

test("a `done` epic is terminal only once its slice PRs resolved (converging or missing slices keep it live)", async () => {
  const epic = { plan_key: "o/r#1", repo: "o/r", title: "Epic", status: "done", process_key: "proc-e", epic_phase: "Done", auto_merge: 1, acknowledged_at: null, created_at: T0, updated_at: T0 };
  const look = async (tasks: Row[], prs: Row[]) =>
    ((await handler(input("o/r#1"), memApp({ plans: [epic], plan_tasks: tasks, pull_requests: prs }, PKS))) as Row).body;
  const slice = [{ id: 1, plan_key: "o/r#1", task_id: "a", pr_key: "o/r#9" }];
  assertEquals((await look(slice, [pr()])).terminal, false);
  assertEquals((await look(slice, [])).terminal, false);
  assertEquals((await look(slice, [pr({ status: "merged", merged_at: T0 })])).terminal, true);
});

test("a failed or abandoned epic is terminal regardless of its slice delivery", async () => {
  for (const status of ["failed", "abandoned"]) {
    const epic = { plan_key: "o/r#1", repo: "o/r", title: "Epic", status, process_key: "proc-e", epic_phase: null, auto_merge: 1, acknowledged_at: null, created_at: T0, updated_at: T0 };
    const slice = [{ id: 1, plan_key: "o/r#1", task_id: "a", pr_key: "o/r#9" }];
    const body = ((await handler(input("o/r#1"), memApp({ plans: [epic], plan_tasks: slice, pull_requests: [pr()] }, PKS))) as Row).body;
    assertEquals(body.terminal, true, status);
  }
});

test("key resolution uses the delivery-aware epic terminal: a `done` epic with unresolved slices beats a newer completed feature", async () => {
  const later = "2026-11-02T00:00:00Z";
  const epic = { plan_key: "o/r#5", repo: "o/r", title: "Epic", status: "done", process_key: "proc-e", epic_phase: "Done", auto_merge: 1, acknowledged_at: null, created_at: T0, updated_at: T0 };
  const slice = [{ id: 1, plan_key: "o/r#5", task_id: "a", pr_key: "o/r#9" }];
  const done = feature({ status: "merged", created_at: later });
  const pick = async (prs: Row[]) =>
    ((await handler(input("o/r#5"), memApp({ feature_runs: [done], plans: [epic], plan_tasks: slice, pull_requests: prs }, PKS))) as Row).body;
  // Converging slice: the epic is still live and wins despite the newer feature.
  const converging = await pick([pr()]);
  assertEquals(converging.kind, "epic");
  assertEquals(converging.terminal, false);
  // Missing slice PR: still live.
  assertEquals((await pick([])).kind, "epic");
  // Every slice merged: both terminal, so the newest-created (the feature) wins.
  assertEquals((await pick([pr({ status: "merged", merged_at: T0 })])).kind, "feature");
});

test("a delegating feature whose child PR closed or failed is terminal", async () => {
  for (const status of ["closed", "failed"]) {
    const app = memApp({ feature_runs: [feature({ status: "converging", pr_key: "o/r#9" })], pull_requests: [pr({ status, active_worker: null })] }, PKS);
    const body = ((await handler(input("o/r#5"), app)) as Row).body;
    assertEquals(body.terminal, true, status);
    assertEquals(body.children[0].terminal, true, status);
  }
});

test("a delegating feature surfaces its live child PR's incident; the stage/terminal stay on the rollup", async () => {
  const inc = { incident_key: "inc-1", incident_since: T0, incident_message: "boom", incident_element: "x" };
  const app = memApp({ feature_runs: [feature({ status: "converging", pr_key: "o/r#9" })], pull_requests: [pr(inc)] }, PKS);
  const body = ((await handler(input("o/r#5"), app)) as Row).body;
  const child = body.children[0];
  assertEquals(body.status, child.status);
  assertEquals(body.incident, child.incident);
  assertEquals(body.incident !== null, true);
  assertEquals(body.terminal, false);
});

test("a feature/epic tie is decided by the newest launch (process key), not the restart-preserved created_at", async () => {
  const later = "2026-11-02T00:00:00Z";
  const epic = { plan_key: "o/r#5", repo: "o/r", title: "Epic", status: "done", process_key: "100", epic_phase: "Done", auto_merge: 0, auto_resolve_escalations: 0, acknowledged_at: null, created_at: later, updated_at: later };
  // The feature row is OLDER by created_at but was restarted (newer engine instance) and finished.
  const restarted = feature({ status: "merged", process_key: "200" });
  const body = ((await handler(input("o/r#5"), memApp({ feature_runs: [restarted], plans: [epic] }, PKS))) as Row).body;
  assertEquals(body.kind, "feature");
});
