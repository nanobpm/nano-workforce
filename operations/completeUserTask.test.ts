// Tests for the POST /app/api/actions/complete-user-task operation `completeUserTask` (issue #236).
// The nwf Tasks page's decision affordance for the plan-review / trial-merge / PR `wait-answer`
// escalations: it routes the typed form variables through the canonical human completer
// (completeEscalationAsHuman → completeUserTaskAttributed), resuming the process exactly as the task
// inbox would, and drops the answered task's read-model row so the grid stops offering a decision.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";
import handler from "./completeUserTask.ts";

// biome-ignore lint/suspicious/noExplicitAny: in-memory doubles, mirrors acknowledgeBlocked.test.ts
function memApp(openTasks: { userTaskKey: string; elementId?: string }[]): {
  app: AppApi;
  // biome-ignore lint/suspicious/noExplicitAny: see above
  stores: Record<string, any[]>;
  completed: { userTaskKey: string; variables: Record<string, unknown> }[];
} {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const stores: Record<string, any[]> = {};
  const completed: { userTaskKey: string; variables: Record<string, unknown> }[] = [];
  function tbl(name: string, pk: string) {
    // biome-ignore lint/suspicious/noExplicitAny: see above
    const rows = (stores[name] ??= [] as any[]);
    return {
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async insert(row: any) {
        rows.push({ ...row });
        return rows.length;
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async get(id: any) {
        return rows.find((r) => r[pk] === id);
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async find(where: any = {}) {
        return rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async delete(id: any) {
        const i = rows.findIndex((r) => r[pk] === id);
        if (i >= 0) rows.splice(i, 1);
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async update(id: any, patch: any) {
        const r = rows.find((row) => row[pk] === id);
        if (r) Object.assign(r, patch);
      },
    };
  }
  const engine = {
    searchUserTasks: async () => openTasks,
    completeUserTask: async (userTaskKey: string, variables: Record<string, unknown>) => {
      completed.push({ userTaskKey, variables });
    },
  };
  const app = {
    data: { table: (n: string, pk: string) => tbl(n, pk) },
    engine,
    log: noopLog(),
    // biome-ignore lint/suspicious/noExplicitAny: test harness cast, mirrors sibling op tests
  } as any as AppApi;
  return { app, stores, completed };
}

async function call(app: AppApi, body: unknown) {
  // biome-ignore lint/suspicious/noExplicitAny: test harness cast, mirrors sibling op tests
  return (await handler({ req: {} as any, params: {}, query: {}, body } as any, app)) as any;
}

test("complete-user-task: completes a plan-review escalation and drops its read-model row", async () => {
  const { app, stores, completed } = memApp([{ userTaskKey: "ut-1", elementId: "plan-review-decision" }]);
  stores.user_tasks = [{ user_task_key: "ut-1", element_id: "plan-review-decision" }];

  const res = await call(app, { userTaskKey: "ut-1", variables: { directive: "revise", notes: "narrow scope" } });

  assertEquals(res.status, 200);
  assertEquals(res.body.ok, true);
  assertEquals(res.body.elementId, "plan-review-decision");
  assertEquals(completed, [{ userTaskKey: "ut-1", variables: { directive: "revise", notes: "narrow scope" } }]);
  assertEquals(stores.user_tasks, []);
  // Attribution recorded as a human completion.
  assertEquals(stores.task_completions.length, 1);
  assertEquals(stores.task_completions[0].actor_kind, "human");
});

test("complete-user-task: completes a trial-merge escalation with the typed action variable", async () => {
  const { app, completed } = memApp([{ userTaskKey: "ut-2", elementId: "trial-merge-decision" }]);

  const res = await call(app, { userTaskKey: "ut-2", variables: { action: "rebase" } });

  assertEquals(res.status, 200);
  assertEquals(completed, [{ userTaskKey: "ut-2", variables: { action: "rebase" } }]);
});

test("complete-user-task: a missing userTaskKey is a 400", async () => {
  const { app } = memApp([]);
  const res = await call(app, { variables: { answer: "x" } });
  assertEquals(res.status, 400);
  assertEquals(res.body.ok, false);
});

test("complete-user-task: non-object variables are rejected 400", async () => {
  const { app } = memApp([{ userTaskKey: "ut-3", elementId: "wait-answer" }]);
  const res = await call(app, { userTaskKey: "ut-3", variables: "nope" });
  assertEquals(res.status, 400);
});

test("complete-user-task: an unknown key is a 404 (no open escalation task)", async () => {
  const { app } = memApp([]);
  const res = await call(app, { userTaskKey: "ghost", variables: { answer: "x" } });
  assertEquals(res.status, 404);
});

test("complete-user-task: refuses a non-escalation user task (400)", async () => {
  const { app, completed } = memApp([{ userTaskKey: "ut-4", elementId: "feature-blocked" }]);
  const res = await call(app, { userTaskKey: "ut-4", variables: { note: "x" } });
  assertEquals(res.status, 400);
  assertEquals(completed, []);
});

test("complete-user-task: a read-model cleanup failure does not mask a resumed completion (200)", async () => {
  const { app, completed } = memApp([{ userTaskKey: "ut-5", elementId: "plan-review-decision" }]);
  // The engine has already resumed the process; a transient delete failure on the latency-optimising
  // read-model cleanup must not surface as a 5xx for a task that IS completed (poller reconciles).
  const realTable = app.data.table.bind(app.data);
  // biome-ignore lint/suspicious/noExplicitAny: test harness cast, mirrors sibling op tests
  (app.data as any).table = (name: string, pk: string) => {
    const t = realTable(name, pk);
    if (name === "user_tasks") {
      return {
        ...t,
        delete: async () => {
          throw new Error("transient DB error");
        },
      };
    }
    return t;
  };

  const res = await call(app, { userTaskKey: "ut-5", variables: { directive: "revise", notes: "narrow scope" } });

  assertEquals(res.status, 200);
  assertEquals(res.body.ok, true);
  assertEquals(completed, [{ userTaskKey: "ut-5", variables: { directive: "revise", notes: "narrow scope" } }]);
});
