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
import { resetDefaultBranchCache } from "../app/github.ts";

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
  resetDefaultBranchCache(); // start cold so a prior warmed cache can't mask the no-transport path
  return run().finally(() => {
    resetDefaultBranchCache();
    if (prev !== undefined) process.env["NANO_PR_GITHUB_TRANSPORT"] = prev;
    else delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    if (prevTok !== undefined) process.env["GITHUB_TOKEN"] = prevTok;
  });
}

// Force the token transport with a stubbed `globalThis.fetch` that serves a minimal in-memory
// github model, so `admitPlan` (which now calls `ensureBaseBranch` + `fetchDefaultBranch`) can run
// without touching the network. The default branch is `main`; an epic/* base is auto-created off it.
function withGithubStub(run: () => Promise<void>): Promise<void> {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevTok = process.env["GITHUB_TOKEN"];
  const prevFetch = globalThis.fetch;
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  process.env["GITHUB_TOKEN"] = "tok";
  resetDefaultBranchCache(); // isolate: don't inherit or leak the owner/repo default-branch entry
  const branches = new Map<string, string>([["main", "mainsha"]]);
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = u.pathname;
    const json = (obj: unknown, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && path === "/repos/owner/repo") return Promise.resolve(json({ default_branch: "main" }));
    const refPrefix = "/repos/owner/repo/git/ref/heads/";
    if (method === "GET" && path.startsWith(refPrefix)) {
      const branch = decodeURIComponent(path.slice(refPrefix.length));
      const sha = branches.get(branch);
      if (sha === undefined) return Promise.resolve(new Response("Not Found", { status: 404 }));
      return Promise.resolve(json({ ref: `refs/heads/${branch}`, object: { sha } }));
    }
    if (method === "POST" && path === "/repos/owner/repo/git/refs") {
      // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
      const body = JSON.parse(String(init?.body ?? "{}")) as { ref?: string; sha?: string };
      const branch = String(body.ref ?? "").replace(/^refs\/heads\//, "");
      if (branches.has(branch)) return Promise.resolve(json({ message: "Reference already exists" }, 422));
      branches.set(branch, String(body.sha ?? ""));
      return Promise.resolve(json({ ref: body.ref }, 201));
    }
    return Promise.resolve(new Response(`unexpected ${method} ${path}`, { status: 500 }));
  }) as typeof fetch;
  return run().finally(() => {
    resetDefaultBranchCache();
    globalThis.fetch = prevFetch;
    if (prevMode !== undefined) process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
    else delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    if (prevTok !== undefined) process.env["GITHUB_TOKEN"] = prevTok;
    else delete process.env["GITHUB_TOKEN"];
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

test("startPlanFanout → 400 on a missing baseBranch (not persisted/rendered)", async () => {
  // A blank/absent baseBranch must be rejected at the edge as a 400 (MissingBaseBranchError),
  // never silently coalesced to the repository default branch (ADR 0003, B0).
  const res = await startPlanFanout(input({ issue: "owner/repo#123" }), app);
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
  await withGithubStub(async () => {
    const { app: capApp } = captureApp();
    const res = await startPlanFanout(
      input({ url: "https://github.com/owner/repo/issues/12", baseBranch: "epic/agent-protocol" }),
      capApp,
    );
    assertEquals((res as any).status, 202);
  });
});

test("postMessage → 400 when name is blank", async () => {
  const res = await postMessage(input({ name: "" }), app);
  const r = res as any;
  assertEquals(r.status, 400);
  assertEquals(r.body.error, "name is required");
});

test("postMessage publishes any named message generically (no bespoke escalation branch)", async () => {
  // Every escalation kind is now a native user task answered via /actions/complete-user-task (#256),
  // so postMessage no longer special-cases `escalation-answered`; it is a thin generic publish. The
  // former `escalation-answered`-without-correlationKey 400 branch is gone — such a message now just
  // publishes (uncorrelated) like any other.
  let published: { name: string; correlationKey?: string; variables?: unknown } | undefined;
  const pubApp = {
    log: noopLog(),
    engine: { publishMessage: (m: any) => ((published = m), Promise.resolve()) },
  } as any as AppApi;
  const res = await postMessage(input({ name: "merge-ready", correlationKey: "o/r#1", variables: { x: 1 } }), pubApp);
  const r = res as any;
  assertEquals(r.status, 200);
  assertEquals(r.body.ok, true);
  assertEquals(published?.name, "merge-ready");
  assertEquals(published?.correlationKey, "o/r#1");
});
