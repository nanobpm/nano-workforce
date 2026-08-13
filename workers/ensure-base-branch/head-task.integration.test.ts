// Integration coverage for the durable HEAD arm of ADR 0003 rule 2 — the `ensure-base-branch`
// service task (taskType `pr.ensure-base-branch`). The unit tests in workers/ensure-base-branch/
// worker.test.ts prove create/no-op in isolation; this file proves the END-TO-END belt-and-suspenders
// property across a RE-PLAN: the head task CREATES a missing epic/* base off default HEAD on the first
// pass, then NO-OPS on a second pass (idempotent — it neither errors nor resets the ref). Driven
// through the real worker handler against a faked github transport — no network, deterministic.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import handler from "../../workers/ensure-base-branch/worker.ts";

interface GithubState {
  repo: string;
  defaultBranch: string;
  branches: Map<string, string>; // branch → head sha
  creates: { ref: string; sha: string }[];
  resets: string[]; // any PATCH/force-update on an existing ref (must stay empty)
}

function githubFetch(state: GithubState) {
  return (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = u.pathname;
    const json = (obj: unknown, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && path === `/repos/${state.repo}`) {
      return Promise.resolve(json({ default_branch: state.defaultBranch }));
    }
    const refPrefix = `/repos/${state.repo}/git/ref/heads/`;
    if (method === "GET" && path.startsWith(refPrefix)) {
      const branch = decodeURIComponent(path.slice(refPrefix.length));
      const sha = state.branches.get(branch);
      if (sha === undefined) return Promise.resolve(new Response("Not Found", { status: 404 }));
      return Promise.resolve(json({ ref: `refs/heads/${branch}`, object: { sha } }));
    }
    if (method === "POST" && path === `/repos/${state.repo}/git/refs`) {
      // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
      const body = JSON.parse(String(init?.body ?? "{}")) as { ref?: string; sha?: string };
      const ref = String(body.ref ?? "");
      const sha = String(body.sha ?? "");
      const branch = ref.replace(/^refs\/heads\//, "");
      if (state.branches.has(branch)) return Promise.resolve(json({ message: "Reference already exists" }, 422));
      state.creates.push({ ref, sha });
      state.branches.set(branch, sha);
      return Promise.resolve(json({ ref }, 201));
    }
    // A ref force-update (reset) would be a PATCH to .../git/refs/heads/<branch>. The idempotent head
    // task must NEVER issue one; record it so the test can assert it stayed untouched.
    if (method === "PATCH" && path.startsWith(`/repos/${state.repo}/git/refs/heads/`)) {
      state.resets.push(decodeURIComponent(path.split("/git/refs/heads/")[1] ?? ""));
      return Promise.resolve(json({ ok: true }));
    }
    return Promise.resolve(new Response(`unexpected ${method} ${path}`, { status: 500 }));
  };
}

async function withGithub<T>(state: GithubState, fn: () => Promise<T>): Promise<T> {
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

function runHead(state: GithubState, repo: string, baseBranch: string) {
  return withGithub(state, () => handler({ variables: { repo, baseBranch } } as any, fakeApp)) as Promise<{
    baseBranchResult: string;
  }>;
}

test("head task: creates a missing epic/* base on first pass, then no-ops on re-plan (idempotent)", async () => {
  const state: GithubState = {
    repo: "owner/epic-repo",
    defaultBranch: "main",
    branches: new Map([["main", "mainhead"]]),
    creates: [],
    resets: [],
  };

  // First pass (fresh plan): the epic/* base is missing → created off default HEAD.
  const first = await runHead(state, state.repo, "epic/gate");
  assertEquals(first.baseBranchResult, "created");
  assertEquals(state.creates, [{ ref: "refs/heads/epic/gate", sha: "mainhead" }]);
  assertEquals(state.branches.get("epic/gate"), "mainhead");

  // Second pass (re-plan / crash-recovery): the branch now exists → clean no-op. No further create,
  // and — critically — no reset of the existing ref (a re-plan must not clobber landed work).
  const second = await runHead(state, state.repo, "epic/gate");
  assertEquals(second.baseBranchResult, "exists");
  assertEquals(state.creates.length, 1); // still just the first create
  assertEquals(state.resets, []); // never reset the ref
  assertEquals(state.branches.get("epic/gate"), "mainhead"); // ref untouched
});

test("head task: a pre-existing base is a pure no-op (no create, no reset)", async () => {
  const state: GithubState = {
    repo: "owner/epic-repo2",
    defaultBranch: "main",
    branches: new Map([
      ["main", "mainhead"],
      ["epic/landed", "landedsha"],
    ]),
    creates: [],
    resets: [],
  };
  const out = await runHead(state, state.repo, "epic/landed");
  assertEquals(out.baseBranchResult, "exists");
  assertEquals(state.creates, []);
  assertEquals(state.resets, []);
  assertEquals(state.branches.get("epic/landed"), "landedsha"); // untouched
});
