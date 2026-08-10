import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";

const hadSecret = Object.prototype.hasOwnProperty.call(process.env, "NANO_PR_WEBHOOK_SECRET");
const previousSecret = process.env.NANO_PR_WEBHOOK_SECRET;
let answerFeatureEscalation: typeof import("./answerFeatureEscalation.ts").default;
try {
  process.env.NANO_PR_WEBHOOK_SECRET = " test-secret ";
  answerFeatureEscalation = (await import("./answerFeatureEscalation.ts")).default;
} finally {
  if (hadSecret && previousSecret !== undefined) process.env.NANO_PR_WEBHOOK_SECRET = previousSecret;
  else delete process.env.NANO_PR_WEBHOOK_SECRET;
}

function memTable(rows: any[], key: string) {
  return {
    find: (where: Record<string, unknown>) =>
      Promise.resolve(rows.filter((row) => Object.entries(where).every(([field, value]) => row[field] === value))),
    update: (value: unknown, patch: Record<string, unknown>) => {
      const row = rows.find((candidate) => candidate[key] === value);
      if (row) Object.assign(row, patch);
      return Promise.resolve(row);
    },
  };
}

function memApp(escalations: any[] = []) {
  const stores: Record<string, { rows: any[]; key: string }> = {
    plans: { rows: [{ plan_key: "owner/repo#9" }], key: "plan_key" },
    plan_escalations: { rows: escalations, key: "id" },
    plan_tasks: { rows: [{ id: 1, plan_key: "owner/repo#9", task_id: "task-1" }], key: "id" },
  };
  const published: Record<string, unknown>[] = [];
  const app = {
    data: {
      table: (name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
    },
    engine: {
      publishMessage: (message: Record<string, unknown>) => {
        published.push(message);
        return Promise.resolve();
      },
    },
  } as any as AppApi;
  return { app, published };
}

function input(body: Record<string, unknown>, secret?: string) {
  const headers = new Headers();
  if (secret !== undefined) headers.set("x-hook-secret", secret);
  return {
    req: {
      method: "POST",
      path: "/app/api/hooks/feature-answer",
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
  const result = await answerFeatureEscalation(input({ corrKey: "owner/repo#9:task-1", answer: "yes" }), app) as any;
  assertEquals(result.status, 401);
  assertEquals(result.body, { ok: false, error: "unauthorized" });
});

test("derives corrKey from plan + task and maps an answered escalation to 200", async () => {
  const { app, published } = memApp([{
    id: 1,
    plan_key: "owner/repo#9",
    task_id: "task-1",
    corr_key: "owner/repo#9:task-1",
    question: "Proceed?",
    status: "open",
  }]);
  const result = await answerFeatureEscalation(
    input({ plan: "owner/repo#9", task: "task-1", answer: " yes " }, "test-secret"),
    app,
  ) as any;
  assertEquals(result.status, 200);
  assertEquals(result.body.ok, true);
  assertEquals(published[0]?.correlationKey, "owner/repo#9:task-1");
  assertEquals((published[0]?.variables as Record<string, unknown>).answer, "yes");
});

test("maps an unmatched corrKey to 404", async () => {
  const { app } = memApp();
  const result = await answerFeatureEscalation(
    input({ corrKey: "owner/repo#9:missing", answer: "yes" }, "test-secret"),
    app,
  ) as any;
  assertEquals(result.status, 404);
  assertEquals(result.body.ok, false);
});
