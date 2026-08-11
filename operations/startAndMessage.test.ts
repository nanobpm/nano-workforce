// Tests for the start/message operation delegates (ADR 0058 OpenAPI surface).
// These cover the app-logic guards the JSON schema can't express (reference parsing, message-name
// dispatch). The delegates reject an unparseable/blank `pr`/`issue` with a 400 (the schema itself
// marks neither required, since `StartVariables` is shared across convergence and planning); the
// runtime's schema-level validation (e.g. `postMessage`'s required `name`) is exercised by urban's
// own api runtime tests.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import startConvergenceLoop from "./startConvergenceLoop.ts";
import startPlanFanout from "./startPlanFanout.ts";
import postMessage from "./postMessage.ts";

const app = {} as any as AppApi;

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
  return { app: { data, engine } as any as AppApi, get: () => captured };
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
