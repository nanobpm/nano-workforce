// Tests for the POST /app/api/actions/acknowledge-blocked operation `acknowledgeBlocked` (issue #220).
// The nwf UI's completion affordance for a blocked feature run parked at `feature-blocked`: it routes
// through the canonical attributed completer (completeBlockedAsHuman → completeUserTaskAttributed),
// resuming the process (→ pr.record-blocked-ack) exactly as the task inbox would, and immediately
// clears the denormalised completable-task pointer so the affordance stops rendering. Mirrors the
// escalation twin (operations/answerFeatureEscalation.ts).
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";
import handler from "./acknowledgeBlocked.ts";

function memApp(openTasks: { userTaskKey: string; elementId?: string }[]): {
  app: AppApi;
  stores: Record<string, any[]>;
  completed: { userTaskKey: string; variables: Record<string, unknown> }[];
} {
  const stores: Record<string, any[]> = {};
  const completed: { userTaskKey: string; variables: Record<string, unknown> }[] = [];
  function tbl(name: string, pk: string) {
    const rows = (stores[name] ??= [] as any[]);
    return {
      async insert(row: any) {
        rows.push({ ...row });
        return rows.length;
      },
      async get(id: any) {
        return rows.find((r) => r[pk] === id);
      },
      async find(where: any = {}) {
        return rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
      },
      async delete(id: any) {
        const i = rows.findIndex((r) => r[pk] === id);
        if (i >= 0) rows.splice(i, 1);
      },
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
  } as any as AppApi;
  return { app, stores, completed };
}

async function call(app: AppApi, body: unknown) {
  return (await handler({ req: {} as any, params: {}, query: {}, body } as any, app)) as any;
}

test("acknowledge-blocked: completes the feature-blocked task, records the note, clears the pointer", async () => {
  const { app, stores, completed } = memApp([{ userTaskKey: "ut-1", elementId: "feature-blocked" }]);
  stores.feature_runs = [{ feature_key: "o/r#1", status: "awaiting_operator", blocked_user_task_key: "ut-1" }];

  const res = await call(app, { userTaskKey: "ut-1", note: "reassigned to a human", operator: "alice" });

  assertEquals(res.status, 200);
  assertEquals(res.body.ok, true);
  // The task is completed with the typed `note` variable the record-blocked-ack ioMapping reads.
  assertEquals(completed.length, 1);
  assertEquals(completed[0].userTaskKey, "ut-1");
  assertEquals(completed[0].variables, { note: "reassigned to a human" });
  // The attribution ledger records WHO acknowledged (a human — the authority, not reversible).
  assertEquals(stores.task_completions.length, 1);
  assertEquals(stores.task_completions[0].actor_kind, "human");
  assertEquals(stores.task_completions[0].actor_id, "alice");
  assertEquals(stores.task_completions[0].reversible, 0);
  // The operation clears its own action's pointer immediately (status left to record-blocked-ack).
  assertEquals(stores.feature_runs[0].blocked_user_task_key, null);
});

test("acknowledge-blocked: a blank note omits the variable so the ioMapping fallback fires", async () => {
  const { app, stores, completed } = memApp([{ userTaskKey: "ut-2", elementId: "feature-blocked" }]);
  stores.feature_runs = [{ feature_key: "o/r#2", status: "awaiting_operator", blocked_user_task_key: "ut-2" }];

  const res = await call(app, { userTaskKey: "ut-2", note: "   " });

  assertEquals(res.status, 200);
  assertEquals(completed[0].variables, {});
});

test("acknowledge-blocked: a missing userTaskKey → 400", async () => {
  const { app } = memApp([]);
  const res = await call(app, { note: "x" });
  assertEquals(res.status, 400);
  assertEquals(res.body.ok, false);
});

test("acknowledge-blocked: no matching open task → 404", async () => {
  const { app } = memApp([]);
  const res = await call(app, { userTaskKey: "ut-gone" });
  assertEquals(res.status, 404);
  assertEquals(res.body.ok, false);
});

test("acknowledge-blocked: refuses a non-blocked task (an escalation) → 400", async () => {
  const { app } = memApp([{ userTaskKey: "ut-esc", elementId: "feature-escalation" }]);
  const res = await call(app, { userTaskKey: "ut-esc" });
  assertEquals(res.status, 400);
  assertEquals(res.body.ok, false);
});
