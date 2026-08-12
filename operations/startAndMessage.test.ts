// Tests for the start/message operation delegates (ADR 0058 OpenAPI surface).
// These cover the app-logic guards the JSON schema can't express (reference FORMAT parsing,
// message-name dispatch) and the derived-union narrowing. The start bodies are now `oneOf` shapes
// (`ConvergenceStart` = pr | url, `PlanStart` = issue | url) — exactly-one-of enforcement and
// extra-key rejection are the runtime's job (exercised by urban's own api runtime tests); here we
// drive the delegate directly with each validated variant and assert it narrows correctly, still
// rejecting an unparseable reference with a 400.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";
import startConvergenceLoop from "./startConvergenceLoop.ts";
import startPlanFanout from "./startPlanFanout.ts";
import postMessage from "./postMessage.ts";

const app = { log: noopLog() } as any as AppApi;

function input(body: any) {
  return {
    req: { method: "POST", path: "/", query: new URLSearchParams(), headers: new Headers(), text: async () => "" } as any,
    params: {},
    query: {},
    body,
  };
}

test("startConvergenceLoop → 400 on an unparseable PR reference", async () => {
  const res = await startConvergenceLoop(input({ pr: "not a pr" }), app);
  const r = res as any;
  assertEquals(r.status, 400);
  assertEquals(typeof r.body.error, "string");
});

// The delegate forwards a per-request review-only override to `submitPr`, coercing strictly: only a
// JSON `true` enables convergence-only (a stray string/other value is NOT truthy-coerced). Drives the
// real delegate → submitPr against an in-memory app and captures the `convergeOnly` process variable.
function captureApp() {
  const rows: Record<string, unknown>[] = [];
  let captured: unknown;
  const data = {
    table: (_name: string, key: string) => ({
      get: (k: unknown) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
      find: (q: Record<string, unknown>) =>
        Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
      insert: (r: Record<string, unknown>) => {
        rows.push(r);
        return Promise.resolve(r);
      },
      update: (k: unknown, patch: Record<string, unknown>) => {
        const row = rows.find((r) => r[key] === k);
        if (row) Object.assign(row, patch);
        return Promise.resolve(row);
      },
      delete: (k: unknown) => {
        const i = rows.findIndex((r) => r[key] === k);
        if (i >= 0) rows.splice(i, 1);
        return Promise.resolve();
      },
    }),
  };
  const engine = {
    createInstance: (req: { variables?: Record<string, unknown> }) => {
      captured = req.variables?.convergeOnly;
      return Promise.resolve({ processInstanceKey: "PI-1" });
    },
  };
  return { app: { data, engine, log: noopLog() } as any as AppApi, get: () => captured };
}

function withGithubOff(run: () => Promise<void>): Promise<void> {
  const prev = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevTok = process.env["GITHUB_TOKEN"];
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token"; // no token → meta fetch is skipped
  delete process.env["GITHUB_TOKEN"];
  return run().finally(() => {
    if (prev !== undefined) process.env["NANO_PR_GITHUB_TRANSPORT"] = prev;
    else delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    if (prevTok !== undefined) process.env["GITHUB_TOKEN"] = prevTok;
  });
}

test("startConvergenceLoop → 400 (not 500) on a missing request body", async () => {
  const res = await startConvergenceLoop(input(undefined), app);
  const r = res as any;
  assertEquals(r.status, 400);
  assertEquals(typeof r.body.error, "string");
});

test("startConvergenceLoop forwards convergeOnly:true to the loop", async () => {
  await withGithubOff(async () => {
    const { app: capApp, get } = captureApp();
    const res = await startConvergenceLoop(input({ pr: "owner/repo#8", convergeOnly: true }), capApp);
    assertEquals((res as any).status, 202);
    assertEquals(get(), true);
  });
});

test("startConvergenceLoop defaults convergeOnly to false and does not truthy-coerce a non-boolean", async () => {
  await withGithubOff(async () => {
    const omitted = captureApp();
    await startConvergenceLoop(input({ pr: "owner/repo#9" }), omitted.app);
    assertEquals(omitted.get(), false);

    const stringy = captureApp();
    await startConvergenceLoop(input({ pr: "owner/repo#10", convergeOnly: "true" }), stringy.app);
    assertEquals(stringy.get(), false);
  });
});

test("startPlanFanout → 400 on an unparseable issue reference", async () => {
  const res = await startPlanFanout(input({ issue: "" }), app);
  const r = res as any;
  assertEquals(r.status, 400);
  assertEquals(typeof r.body.error, "string");
});

test("startPlanFanout → 400 (not 500) on a missing request body", async () => {
  const res = await startPlanFanout(input(undefined), app);
  const r = res as any;
  assertEquals(r.status, 400);
  assertEquals(typeof r.body.error, "string");
});

test("startPlanFanout → 400 on an invalid baseBranch (not persisted/rendered)", async () => {
  // A non-blank baseBranch that isn't a plausible git branch name (shell metacharacters here)
  // must be rejected at the edge as a 400 — never persisted or interpolated into the agent prompt.
  const res = await startPlanFanout(
    input({ issue: "owner/repo#123", baseBranch: "epic/agent; rm -rf /" }),
    app,
  );
  const r = res as any;
  assertEquals(r.status, 400);
  assertEquals(typeof r.body.error, "string");
});

test("startConvergenceLoop narrows the `url` variant (no `pr` key)", async () => {
  await withGithubOff(async () => {
    const { app: capApp } = captureApp();
    const res = await startConvergenceLoop(input({ url: "https://github.com/owner/repo/pull/11" }), capApp);
    assertEquals((res as any).status, 202);
  });
});

test("startPlanFanout narrows the `url` variant (no `issue` key)", async () => {
  await withGithubOff(async () => {
    const { app: capApp } = captureApp();
    const res = await startPlanFanout(input({ url: "https://github.com/owner/repo/issues/12" }), capApp);
    assertEquals((res as any).status, 202);
  });
});

test("postMessage → 400 when name is blank", async () => {
  const res = await postMessage(input({ name: "" }), app);
  const r = res as any;
  assertEquals(r.status, 400);
  assertEquals(r.body.error, "name is required");
});

test("postMessage → 400 when escalation-answered lacks a correlationKey", async () => {
  const res = await postMessage(input({ name: "escalation-answered", variables: { answer: "yes" } }), app);
  const r = res as any;
  assertEquals(r.status, 400);
  assertEquals(r.body.error, "correlationKey is required");
});

function planEscalationMessageApp() {
  const plans = [{ plan_key: "owner/repo#12", open_plan_escalation_id: 1 }];
  const escalations = [{
    id: 1,
    plan_key: "owner/repo#12",
    epoch: 0,
    round: 2,
    findings: "needs guidance",
    status: "open",
    directive: null,
    note: null,
  }];
  const published: any[] = [];
  const match = (r: Record<string, unknown>, q: Record<string, unknown>) =>
    Object.entries(q).every(([f, v]) => r[f] === v);
  const table = (rows: any[], key: string) => ({
    find: (q: any) => Promise.resolve(rows.filter((r) => match(r, q))),
    update: (id: any, patch: any) => {
      const row = rows.find((r) => r[key] === id);
      if (row) Object.assign(row, patch);
      return Promise.resolve(row);
    },
  });
  return {
    app: {
      data: {
        table(name: string) {
          return name === "plans" ? table(plans, "plan_key") : table(escalations, "id");
        },
      },
      engine: {
        publishMessage: (m: any) => {
          published.push(m);
          return Promise.resolve();
        },
      },
      log: noopLog(),
    } as any as AppApi,
    escalations,
    published,
  };
}

test("postMessage accepts mixed-case plan escalation directive like the dedicated hook", async () => {
  const { app: msgApp, escalations, published } = planEscalationMessageApp();
  const res = await postMessage(input({
    name: "plan-escalation-answered",
    correlationKey: "owner/repo#12",
    variables: { directive: "PrOcEeD", note: "ship it" },
  }), msgApp);
  const r = res as any;
  assertEquals(r.status, 200);
  assertEquals(r.body.ok, true);
  assertEquals(r.body.directive, "proceed");
  assertEquals(escalations[0].directive, "proceed");
  assertEquals(published[0].variables.planEscalationDirective, "proceed");
});
