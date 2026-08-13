// pr.ensure-base-branch worker — the durable, retriable head arm of ADR 0003 rule 2.
//
// It re-runs the idempotent `ensureBaseBranch` primitive on the durable path, so it must CREATE a
// missing epic/* base off default HEAD and NO-OP when the branch already exists. Drive it through a
// faked github transport (token mode + stubbed `globalThis.fetch`) so no network is touched.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import handler from "./worker.ts";

interface FakeRepo {
  repo: string;
  defaultBranch: string;
  branches: Map<string, string>; // branch name → head sha
  creates: { ref: string; sha: string }[];
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

function githubFetch(state: FakeRepo) {
  return (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = u.pathname;
    if (method === "GET" && path === `/repos/${state.repo}`) {
      return Promise.resolve(jsonResponse({ default_branch: state.defaultBranch }));
    }
    const refPrefix = `/repos/${state.repo}/git/ref/heads/`;
    if (method === "GET" && path.startsWith(refPrefix)) {
      const branch = decodeURIComponent(path.slice(refPrefix.length));
      const sha = state.branches.get(branch);
      if (sha === undefined) return Promise.resolve(new Response("Not Found", { status: 404 }));
      return Promise.resolve(jsonResponse({ ref: `refs/heads/${branch}`, object: { sha } }));
    }
    if (method === "POST" && path === `/repos/${state.repo}/git/refs`) {
      // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
      const body = JSON.parse(String(init?.body ?? "{}")) as { ref?: string; sha?: string };
      const ref = String(body.ref ?? "");
      const sha = String(body.sha ?? "");
      const branch = ref.replace(/^refs\/heads\//, "");
      if (state.branches.has(branch)) return Promise.resolve(jsonResponse({ message: "Reference already exists" }, 422));
      state.creates.push({ ref, sha });
      state.branches.set(branch, sha);
      return Promise.resolve(jsonResponse({ ref }, 201));
    }
    return Promise.resolve(new Response(`unexpected ${method} ${path}`, { status: 500 }));
  };
}

async function withGithub<T>(state: FakeRepo, fn: () => Promise<T>): Promise<T> {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevTok = process.env["GITHUB_TOKEN"];
  const prevFetch = globalThis.fetch;
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  process.env["GITHUB_TOKEN"] = "tok";
  globalThis.fetch = githubFetch(state) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prevFetch;
    if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
    if (prevTok === undefined) delete process.env["GITHUB_TOKEN"];
    else process.env["GITHUB_TOKEN"] = prevTok;
  }
}

const fakeApp = { log: { info() {}, warn() {}, error() {} } } as any;

async function run(state: FakeRepo, repo: string, baseBranch: string) {
  return withGithub(state, () => handler({ variables: { repo, baseBranch } } as any, fakeApp)) as Promise<{
    baseBranchResult: string;
  }>;
}

test("ensure-base-branch worker: creates a missing epic/* base off default HEAD", async () => {
  const state: FakeRepo = {
    repo: "o/w-create",
    defaultBranch: "main",
    branches: new Map([["main", "defaulthead"]]),
    creates: [],
  };
  const out = await run(state, state.repo, "epic/new");
  assertEquals(out.baseBranchResult, "created");
  assertEquals(state.creates, [{ ref: "refs/heads/epic/new", sha: "defaulthead" }]);
});

test("ensure-base-branch worker: no-ops when the branch already exists (idempotent re-plan)", async () => {
  const state: FakeRepo = {
    repo: "o/w-exists",
    defaultBranch: "main",
    branches: new Map([
      ["main", "defaulthead"],
      ["epic/already", "existingsha"],
    ]),
    creates: [],
  };
  const out = await run(state, state.repo, "epic/already");
  assertEquals(out.baseBranchResult, "exists");
  assertEquals(state.creates.length, 0);
  // The existing ref must be left untouched.
  assertEquals(state.branches.get("epic/already"), "existingsha");
});
