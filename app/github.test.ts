// Unit tests for `fetchPrFiles` token-transport paging (issue #58): the D2 conflict-scan must get
// a COMPLETE file list or a thrown error — never a silently truncated one that under-approximates
// the merge-exclusion graph. Force the token transport and stub `globalThis.fetch`.
import { test } from "node:test";
import { assertEquals, assertRejects } from "#test-assert";
import { BaseBranchMustExistError, ensureBaseBranch, fetchIssueTitle, fetchPrFiles, isNotAPullRequestError } from "./github.ts";

// A fake `fetch` that serves `pages` of file batches; each page N (1-based) returns `pages[N-1]`
// files (named `f{index}`), setting a `Link: rel="next"` header whenever a later page exists.
function stubFetch(pages: number[]) {
  const total = pages.reduce((a, b) => a + b, 0);
  return (url: string | URL | Request): Promise<Response> => {
    const u = new URL(String(url));
    const page = Number(u.searchParams.get("page") ?? "1");
    const count = pages[page - 1] ?? 0;
    const start = pages.slice(0, page - 1).reduce((a, b) => a + b, 0);
    const body = Array.from({ length: count }, (_, i) => ({ filename: `f${start + i}` }));
    const headers = new Headers();
    if (page < pages.length) {
      headers.set("link", `<https://api.github.com/next?page=${page + 1}>; rel="next"`);
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers }),
    );
  };
}

async function withTokenTransport<T>(pages: number[], fn: () => Promise<T>): Promise<T> {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevFetch = globalThis.fetch;
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  globalThis.fetch = stubFetch(pages) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prevFetch;
    if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
  }
}

test("fetchPrFiles: returns the complete list for a sub-cap PR (short final page)", async () => {
  const files = await withTokenTransport([100, 42], () => fetchPrFiles("o/r", 1, "tok"));
  assertEquals(files?.length, 142);
});

test("fetchPrFiles: exactly 500 files with no next page is complete, not truncated", async () => {
  // 5 full pages, but no `rel="next"` on the last → the list is exactly complete at the cap.
  const files = await withTokenTransport([100, 100, 100, 100, 100], () => fetchPrFiles("o/r", 2, "tok"));
  assertEquals(files?.length, 500);
});

test("fetchPrFiles: throws when the cap genuinely truncates (full last page + next)", async () => {
  // 6 pages available but only 5 fetched → the 5th page still advertises `rel="next"`.
  await assertRejects(
    () => withTokenTransport([100, 100, 100, 100, 100, 100], () => fetchPrFiles("o/r", 3, "tok")),
    Error,
    "truncated",
  );
});

// ── ensureBaseBranch (ADR 0003 rule 2) ──────────────────────────────────────
// Force the token transport and stub `globalThis.fetch` so the create-if-missing primitive is
// exercised end-to-end without touching the network: git-ref lookups, default-branch resolution,
// and ref creation are all served from an in-memory repo model that records every create call.
interface FakeRepo {
  repo: string;
  defaultBranch: string;
  branches: Map<string, string>; // branch name → head sha (includes the default branch)
  creates: { ref: string; sha: string }[];
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function githubFetch(state: FakeRepo) {
  return (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = u.pathname;
    // Repo metadata → default branch (fetchDefaultBranch token mode).
    if (method === "GET" && path === `/repos/${state.repo}`) {
      return Promise.resolve(jsonResponse({ default_branch: state.defaultBranch }));
    }
    // Git ref lookup → head sha or 404.
    const refPrefix = `/repos/${state.repo}/git/ref/heads/`;
    if (method === "GET" && path.startsWith(refPrefix)) {
      const branch = decodeURIComponent(path.slice(refPrefix.length));
      const sha = state.branches.get(branch);
      if (sha === undefined) return Promise.resolve(new Response("Not Found", { status: 404 }));
      return Promise.resolve(jsonResponse({ ref: `refs/heads/${branch}`, object: { sha } }));
    }
    // Create ref.
    if (method === "POST" && path === `/repos/${state.repo}/git/refs`) {
      // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
      const body = JSON.parse(String(init?.body ?? "{}")) as { ref?: string; sha?: string };
      const ref = String(body.ref ?? "");
      const sha = String(body.sha ?? "");
      const branch = ref.replace(/^refs\/heads\//, "");
      if (state.branches.has(branch)) {
        return Promise.resolve(jsonResponse({ message: "Reference already exists" }, 422));
      }
      state.creates.push({ ref, sha });
      state.branches.set(branch, sha);
      return Promise.resolve(jsonResponse({ ref }, 201));
    }
    return Promise.resolve(new Response(`unexpected ${method} ${path}`, { status: 500 }));
  };
}

async function withGithub<T>(state: FakeRepo, fn: () => Promise<T>): Promise<T> {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevFetch = globalThis.fetch;
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  globalThis.fetch = githubFetch(state) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prevFetch;
    if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
  }
}

test("ensureBaseBranch: existing branch is a no-op (never creates/resets the ref)", async () => {
  const state: FakeRepo = {
    repo: "o/exists",
    defaultBranch: "main",
    branches: new Map([
      ["main", "mainsha"],
      ["epic/already-there", "existingsha"],
    ]),
    creates: [],
  };
  const result = await withGithub(state, () =>
    ensureBaseBranch(state.repo, "epic/already-there", "tok"),
  );
  assertEquals(result, "exists");
  assertEquals(state.creates.length, 0);
  // The ref must be left untouched.
  assertEquals(state.branches.get("epic/already-there"), "existingsha");
});

test("ensureBaseBranch: missing epic/* branch is created off the default branch HEAD", async () => {
  const state: FakeRepo = {
    repo: "o/create-epic",
    defaultBranch: "main",
    branches: new Map([["main", "defaulthead"]]),
    creates: [],
  };
  const result = await withGithub(state, () =>
    ensureBaseBranch(state.repo, "epic/new-feature", "tok"),
  );
  assertEquals(result, "created");
  assertEquals(state.creates, [{ ref: "refs/heads/epic/new-feature", sha: "defaulthead" }]);
});

test("ensureBaseBranch: idempotent — a second call once the branch exists is a no-op", async () => {
  const state: FakeRepo = {
    repo: "o/idempotent",
    defaultBranch: "main",
    branches: new Map([["main", "defaulthead"]]),
    creates: [],
  };
  const first = await withGithub(state, () => ensureBaseBranch(state.repo, "epic/twice", "tok"));
  assertEquals(first, "created");
  assertEquals(state.creates.length, 1);
  // Re-plan / durable head-task re-run: the branch now exists → clean no-op, no second create.
  const second = await withGithub(state, () => ensureBaseBranch(state.repo, "epic/twice", "tok"));
  assertEquals(second, "exists");
  assertEquals(state.creates.length, 1);
});

test(
  'ensureBaseBranch: concurrent create race (GET 404 then POST 422) reports "exists", not "created"',
  async () => {
    // Simulate losing the create race: the ref lookup 404s (so we attempt a create), but by the
    // time our POST lands another actor has already created the ref → GitHub answers 422. The
    // 422 is idempotent, and the outcome must be the honest "exists" (we did not create it), not
    // a misleading "created". This locks in the retriable semantics for a concurrent create.
    const state: FakeRepo = {
      repo: "o/race",
      defaultBranch: "main",
      branches: new Map([["main", "defaulthead"]]),
      creates: [],
    };
    // The git-ref lookup for the epic branch always 404s (as if it does not exist yet), while a
    // concurrent actor has "already created" it so our POST sees a 422.
    const base = githubFetch(state);
    const racingFetch = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const u = new URL(String(url));
      const method = (init?.method ?? "GET").toUpperCase();
      const path = u.pathname;
      if (method === "GET" && path === `/repos/${state.repo}/git/ref/heads/epic/raced`) {
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }
      if (method === "POST" && path === `/repos/${state.repo}/git/refs`) {
        return Promise.resolve(jsonResponse({ message: "Reference already exists" }, 422));
      }
      return base(url, init);
    };
    const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
    const prevFetch = globalThis.fetch;
    process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
    globalThis.fetch = racingFetch as typeof fetch;
    try {
      const result = await ensureBaseBranch(state.repo, "epic/raced", "tok");
      assertEquals(result, "exists");
    } finally {
      globalThis.fetch = prevFetch;
      if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
      else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
    }
  },
);

test("ensureBaseBranch: missing non-epic/* branch throws BaseBranchMustExistError", async () => {
  const state: FakeRepo = {
    repo: "o/typo",
    defaultBranch: "main",
    branches: new Map([["main", "defaulthead"]]),
    creates: [],
  };
  const err = await withGithub(state, () =>
    assertRejects(
      () => ensureBaseBranch(state.repo, "feature/typo", "tok"),
      BaseBranchMustExistError,
      "feature/typo",
    ),
  );
  assertEquals(err instanceof BaseBranchMustExistError, true);
  // A rejected non-epic/* base must never spawn a wrong-rooted branch.
  assertEquals(state.creates.length, 0);
});

// A `Depends-on:` ref that resolves to an issue (or a non-existent number) can never merge, so the
// merge-poller's dependency gate must treat it as non-blocking rather than wedging forever — the
// exact wedge behind Magikcraft/nano-bpm#806 declaring `Depends-on:` its epic tracking *issue*
// #796. `isNotAPullRequestError` is the discriminator: it must fire for both transports' "not a PR"
// signals and stay false for transient failures (which must keep the dependency blocking).
test("isNotAPullRequestError: gh GraphQL 'not a PullRequest' → true", () => {
  const err = new Error(
    "GraphQL: Could not resolve to a PullRequest with the number of 796. (repository.pullRequest)",
  );
  assertEquals(isNotAPullRequestError(err), true);
});

test("isNotAPullRequestError: token-mode 404 → true", () => {
  assertEquals(isNotAPullRequestError(new Error("github 404 Not Found")), true);
});

test("isNotAPullRequestError: transient failures stay blocking (false)", () => {
  assertEquals(isNotAPullRequestError(new Error("github 502 Bad Gateway")), false);
  assertEquals(isNotAPullRequestError(new Error("API rate limit exceeded")), false);
  assertEquals(isNotAPullRequestError(new Error("fetch failed")), false);
  assertEquals(isNotAPullRequestError(null), false);
});

// Issue #248: `fetchIssueTitle` labels the epics/feature rows with the real GitHub issue title. It
// is best-effort and MUST be tolerant of failure (returns null, never throws) so a title fetch can
// never block an epic/feature start — the caller falls back to the `owner/repo#N` key.
function withTitleFetch<T>(
  fetchImpl: typeof globalThis.fetch,
  token: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevTok = process.env["GITHUB_TOKEN"];
  const prevFetch = globalThis.fetch;
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  if (token === undefined) delete process.env["GITHUB_TOKEN"];
  else process.env["GITHUB_TOKEN"] = token;
  globalThis.fetch = fetchImpl;
  const restore = () => {
    globalThis.fetch = prevFetch;
    if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
    if (prevTok === undefined) delete process.env["GITHUB_TOKEN"];
    else process.env["GITHUB_TOKEN"] = prevTok;
  };
  return fn().finally(restore);
}

test("fetchIssueTitle: returns the title on a successful token-transport read", async () => {
  const stub = ((url: string | URL | Request) => {
    assertEquals(String(url).endsWith("/repos/owner/repo/issues/248"), true);
    return Promise.resolve(new Response(JSON.stringify({ title: "Surface titles" }), { status: 200 }));
  }) as typeof fetch;
  const title = await withTitleFetch(stub, "t0ken", () => fetchIssueTitle("owner/repo", 248, "t0ken"));
  assertEquals(title, "Surface titles");
});

test("fetchIssueTitle: a non-2xx response yields null (best-effort, never throws)", async () => {
  const stub = (() => Promise.resolve(new Response("nope", { status: 404 }))) as typeof fetch;
  const title = await withTitleFetch(stub, "t0ken", () => fetchIssueTitle("owner/repo", 999, "t0ken"));
  assertEquals(title, null);
});

test("fetchIssueTitle: a thrown transport error is swallowed to null", async () => {
  const stub = (() => Promise.reject(new Error("network down"))) as typeof fetch;
  const title = await withTitleFetch(stub, "t0ken", () => fetchIssueTitle("owner/repo", 7, "t0ken"));
  assertEquals(title, null);
});

test("fetchIssueTitle: token mode with no token is a no-op (null)", async () => {
  const stub = (() => {
    throw new Error("fetch must not be called without a token");
  }) as typeof fetch;
  const title = await withTitleFetch(stub, undefined, () => fetchIssueTitle("owner/repo", 7, ""));
  assertEquals(title, null);
});
