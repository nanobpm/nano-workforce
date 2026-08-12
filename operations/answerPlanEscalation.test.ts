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
    plans: { rows: [{ plan_key: "owner/repo#9", open_plan_escalation_id: 1 }], key: "plan_key" },
    plan_review_escalations: { rows: escalations, key: "id" },
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
    log: noopLog(),
  } as any as AppApi;
  return { app, published, stores };
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

test("answers an open plan escalation and publishes the plan correlation message", async () => {
  const { app, published, stores } = memApp([{
    id: 1,
    plan_key: "owner/repo#9",
    epoch: 0,
    round: 2,
    findings: "needs wave 0",
    status: "open",
  }]);
  const result = await answerPlanEscalation(
    input({ plan: "owner/repo#9", directive: "revise", note: " use issue-1 first " }, "test-secret"),
    app,
  ) as any;
  assertEquals(result.status, 200);
  assertEquals(result.body.ok, true);
  assertEquals(stores.plan_review_escalations.rows[0].status, "answered");
  assertEquals(stores.plan_review_escalations.rows[0].directive, "revise");
  assertEquals(stores.plan_review_escalations.rows[0].note, "use issue-1 first");
  assertEquals(published[0]?.name, "plan-escalation-answered");
  assertEquals(published[0]?.correlationKey, "owner/repo#9");
  assertEquals((published[0]?.variables as Record<string, unknown>).planEscalationDirective, "revise");
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
