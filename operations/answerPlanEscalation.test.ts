import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";

const hadSecret = Object.prototype.hasOwnProperty.call(process.env, "NANO_PR_WEBHOOK_SECRET");
const previousSecret = process.env.NANO_PR_WEBHOOK_SECRET;
let answerPlanEscalation: typeof import("./answerPlanEscalation.ts").default;
try {
  process.env.NANO_PR_WEBHOOK_SECRET = " test-secret ";
  answerPlanEscalation = (await import("./answerPlanEscalation.ts")).default;
} finally {
  if (hadSecret && previousSecret !== undefined) process.env.NANO_PR_WEBHOOK_SECRET = previousSecret;
  else delete process.env.NANO_PR_WEBHOOK_SECRET;
}

function memTable(rows: any[], key: string) {
  return {
    get: (value: unknown) => Promise.resolve(rows.find((candidate) => candidate[key] === value) ?? null),
    find: (where: Record<string, unknown>) =>
      Promise.resolve(rows.filter((row) => Object.entries(where).every(([field, value]) => row[field] === value))),
    update: (value: unknown, patch: Record<string, unknown>) => {
      const row = rows.find((candidate) => candidate[key] === value);
      if (row) Object.assign(row, patch);
      return Promise.resolve(row);
    },
  };
}

function memApp(openTasks: any[] = []) {
  const stores: Record<string, { rows: any[]; key: string }> = {
    plans: { rows: [{ plan_key: "owner/repo#9", process_key: "pk-9" }], key: "plan_key" },
  };
  const completed: Array<{ userTaskKey: string; variables?: Record<string, unknown> }> = [];
  const app = {
    data: {
      table: (name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
    },
    engine: {
      searchUserTasks: (_filter?: Record<string, unknown>) => Promise.resolve(openTasks),
      completeUserTask: (userTaskKey: string, variables?: Record<string, unknown>) => {
        completed.push({ userTaskKey, variables });
        return Promise.resolve();
      },
    },
    log: noopLog(),
  } as any as AppApi;
  return { app, completed, stores };
}

function input(body: Record<string, unknown>, secret?: string) {
  const headers = new Headers();
  if (secret !== undefined) headers.set("x-hook-secret", secret);
  return {
    req: {
      method: "POST",
      path: "/app/api/hooks/plan-answer",
      query: new URLSearchParams(),
      headers,
      text: async () => "",
    } as any,
    params: {},
    query: {},
    body,
  };
}

test("rejects a request without the configured hook secret", async () => {
  const { app } = memApp();
  const result = await answerPlanEscalation(input({ plan: "owner/repo#9", directive: "revise" }), app) as any;
  assertEquals(result.status, 401);
  assertEquals(result.body, { ok: false, error: "unauthorized" });
});

test("answers an open plan escalation by completing the parked user task", async () => {
  const { app, completed } = memApp([{
    userTaskKey: "ut-plan",
    elementId: "plan-review-decision",
    variables: {},
  }]);
  const result = await answerPlanEscalation(
    input({ plan: "owner/repo#9", directive: "revise", note: " use issue-1 first " }, "test-secret"),
    app,
  ) as any;
  assertEquals(result.status, 200);
  assertEquals(result.body.ok, true);
  assertEquals(result.body.directive, "revise");
  assertEquals(completed[0]?.userTaskKey, "ut-plan");
  assertEquals(completed[0]?.variables, { directive: "revise", notes: "use issue-1 first" });
});

test("maps an unmatched plan to 404", async () => {
  const { app } = memApp();
  const result = await answerPlanEscalation(
    input({ plan: "owner/repo#missing", directive: "revise" }, "test-secret"),
    app,
  ) as any;
  assertEquals(result.status, 404);
  assertEquals(result.body.ok, false);
});

test("rejects an invalid directive with 400", async () => {
  const { app } = memApp();
  const result = await answerPlanEscalation(
    input({ plan: "owner/repo#9", directive: "ship-it" }, "test-secret"),
    app,
  ) as any;
  assertEquals(result.status, 400);
  assertEquals(result.body.ok, false);
});
