// Unit tests for `fetchPrFiles` token-transport paging (issue #58): the D2 conflict-scan must get
// a COMPLETE file list or a thrown error — never a silently truncated one that under-approximates
// the merge-exclusion graph. Force the token transport and stub `globalThis.fetch`.
import { test } from "node:test";
import { assertEquals, assertRejects } from "#test-assert";
import { BaseBranchMustExistError, checkConclusions, classifyMergeability, classifyPrLiveness, coalesceTitle, createPullRequest, ensureBaseBranch, ensurePromotionPr, fetchIssueTitle, fetchPrFiles, isNotAPullRequestError, listPrsForHead, type Mergeability, type PrState } from "./github.ts";
import { DEFAULT_MERGE_PROTOCOL, type MergeProtocol, type RequiredCheck } from "./mergeProtocol.ts";

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

// Issue #248: `coalesceTitle` guarantees a non-blank identity for the title-led grids. A best-effort
// fetch can legitimately return "" (or whitespace) — `??` would persist that blank; `coalesceTitle`
// treats it as missing (matching the 036 backfill's `trim(title) = ''`) and falls back to the key.
test("coalesceTitle: a non-blank first candidate wins", () => {
  assertEquals(coalesceTitle("Real title", "owner/repo#1"), "Real title");
});

test("coalesceTitle: null/undefined candidates fall through to the key", () => {
  assertEquals(coalesceTitle(null, "owner/repo#1"), "owner/repo#1");
  assertEquals(coalesceTitle(undefined, "owner/repo#1"), "owner/repo#1");
});

test("coalesceTitle: a blank/whitespace title counts as missing", () => {
  assertEquals(coalesceTitle("", "owner/repo#1"), "owner/repo#1");
  assertEquals(coalesceTitle("   ", "owner/repo#1"), "owner/repo#1");
});

test("coalesceTitle: skips a blank middle candidate to the next non-blank one", () => {
  assertEquals(coalesceTitle("", "Prior title", "owner/repo#1"), "Prior title");
  assertEquals(coalesceTitle(null, "  ", "owner/repo#1"), "owner/repo#1");
});

// ── Epic promotion PR helpers (issue #299) ──────────────────────────────────
// The promotion pass opens exactly one `epic/* → <default>` PR per landed epic. These unit tests
// pin the GitHub token-transport primitives it relies on: reading PRs by head branch (idempotency
// reconciliation), creating a PR, and the `ensurePromotionPr` reuse-vs-create decision.
interface FakePulls {
  repo: string;
  // head branch → list of PRs opened from it
  byHead: Map<string, { number: number; state: string; baseRef: string }[]>;
  creates: { head: string; base: string; number: number }[];
  next: number;
}

function pullsFetch(state: FakePulls) {
  return (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = u.pathname;
    if (method === "GET" && path === `/repos/${state.repo}/pulls`) {
      const head = (u.searchParams.get("head") ?? "").split(":").pop() ?? "";
      const list = state.byHead.get(head) ?? [];
      return Promise.resolve(
        jsonResponse(
          list.map((p) => ({
            number: p.number,
            html_url: `https://github.com/${state.repo}/pull/${p.number}`,
            state: p.state,
            base: { ref: p.baseRef },
          })),
        ),
      );
    }
    if (method === "POST" && path === `/repos/${state.repo}/pulls`) {
      // biome-ignore lint/plugin: test fixture parsing an external body shape
      const body = JSON.parse(String(init?.body ?? "{}")) as { head?: string; base?: string };
      const head = String(body.head ?? "");
      const base = String(body.base ?? "");
      const number = state.next++;
      state.creates.push({ head, base, number });
      const arr = state.byHead.get(head) ?? [];
      arr.push({ number, state: "open", baseRef: base });
      state.byHead.set(head, arr);
      return Promise.resolve(jsonResponse({ number, html_url: `https://github.com/${state.repo}/pull/${number}` }, 201));
    }
    return Promise.resolve(new Response(`unexpected ${method} ${path}`, { status: 500 }));
  };
}

async function withPulls<T>(state: FakePulls, fn: () => Promise<T>): Promise<T> {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevFetch = globalThis.fetch;
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  globalThis.fetch = pullsFetch(state) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prevFetch;
    if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
  }
}

function freshPulls(): FakePulls {
  return { repo: "o/r", byHead: new Map(), creates: [], next: 500 };
}

test("listPrsForHead: returns the PRs opened from a head branch", async () => {
  const state = freshPulls();
  state.byHead.set("epic/x", [{ number: 12, state: "open", baseRef: "main" }]);
  const list = await withPulls(state, () => listPrsForHead("o/r", "epic/x", "tok"));
  assertEquals(list?.length, 1);
  assertEquals(list?.[0].number, 12);
  assertEquals(list?.[0].baseRef, "main");
});

test("createPullRequest: opens a PR and returns its number + url", async () => {
  const state = freshPulls();
  const pr = await withPulls(state, () => createPullRequest("o/r", "epic/x", "main", "T", "B", "tok"));
  assertEquals(pr?.number, 500);
  assertEquals(state.creates.length, 1);
  assertEquals(state.creates[0].base, "main");
});

test("ensurePromotionPr: creates when none exists, then reuses on a re-run (idempotent)", async () => {
  const state = freshPulls();
  const first = await withPulls(state, () => ensurePromotionPr("o/r", "epic/x", "main", "T", "B", "tok"));
  assertEquals(first?.created, true);
  assertEquals(first?.number, 500);
  const second = await withPulls(state, () => ensurePromotionPr("o/r", "epic/x", "main", "T", "B", "tok"));
  assertEquals(second?.created, false);
  assertEquals(second?.number, 500);
  assertEquals(state.creates.length, 1);
});
// The shared PR-liveness gate (#342) maps live GitHub state onto one of {open, merged, closed,
// unknown} so neither durable loop (merge/convergence) can escalate against a non-open PR. A closed
// PR is terminal (abandon), a merged PR completes, and a null read stays conservative (unknown →
// proceed as before). `merged` wins over `state` because a merged PR also reports state="closed".
function prState(over: Partial<PrState>): PrState {
  return {
    merged: false,
    state: "open",
    mergeStateStatus: "CLEAN",
    failingChecks: 0,
    failingCheckNames: [],
    presentCheckNames: [],
    pendingCheckNames: [],
    checkConclusions: {},
    totalChecks: 0,
    isDraft: false,
    headRefOid: null,
    mergeQueueEntry: null,
    ...over,
  };
}

test("classifyPrLiveness: an open PR proceeds", () => {
  assertEquals(classifyPrLiveness(prState({ state: "open" })), "open");
});

test("classifyPrLiveness: a merged PR completes (merged wins over a closed state)", () => {
  assertEquals(classifyPrLiveness(prState({ merged: true, state: "closed" })), "merged");
  assertEquals(classifyPrLiveness(prState({ merged: true, state: "merged" })), "merged");
});

test("classifyPrLiveness: a closed-not-merged PR is terminal (abandon)", () => {
  assertEquals(classifyPrLiveness(prState({ merged: false, state: "closed" })), "closed");
});

test("classifyPrLiveness: a null read (transport hiccup) is unknown — never abandons blind", () => {
  assertEquals(classifyPrLiveness(null), "unknown");
});

// ── classifyMergeability: protocol-aware required-checks backstop (issue #392) ────────────────────
//
// The merge poller must NOT merge a PR whose DECLARED-required check is red, even on a repo that
// under-specifies its GitHub-required checks (so GitHub reports the PR as UNSTABLE, i.e. "only
// non-required checks failing" from GitHub's view). `classifyMergeability` now intersects the repo's
// merge-protocol `requiredChecks[]`/`waitForChecks` against the head's latest-run-per-check
// conclusions (via `latestRunPerCheck`, preserving the #348 CANCELLED-supersede semantics) as an
// independent backstop that runs BEFORE the `mergeStateStatus` switch. These are pure unit tests.

// Build a `PrState` with sensible defaults; `over` supplies the fields a case cares about. `over`
// may pass a `rollup` shorthand (name → conclusion) that we compile into the exact per-check fields
// `classifyMergeability` reads (present/pending/conclusions), mirroring what `fetchPrState` derives.
function mergePrState(over: Partial<PrState> & { rollup?: { name: string; conclusion: string }[] } = {}): PrState {
  const { rollup, ...rest } = over;
  const base: PrState = {
    merged: false,
    state: "open",
    mergeStateStatus: "CLEAN",
    failingChecks: 0,
    failingCheckNames: [],
    totalChecks: 0,
    presentCheckNames: [],
    pendingCheckNames: [],
    checkConclusions: {},
    isDraft: false,
    headRefOid: "abc123",
    mergeQueueEntry: null,
  };
  if (rollup) {
    const bad = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
    const pendingStates = new Set(["", "PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING"]);
    const present: string[] = [];
    const pending: string[] = [];
    const failing: string[] = [];
    const conclusions: Record<string, string> = {};
    for (const c of rollup) {
      const v = c.conclusion.toUpperCase();
      present.push(c.name);
      conclusions[c.name] = pendingStates.has(v) ? "" : v;
      if (pendingStates.has(v)) pending.push(c.name);
      else if (bad.has(v)) failing.push(c.name);
    }
    base.presentCheckNames = present;
    base.pendingCheckNames = pending;
    base.checkConclusions = conclusions;
    base.failingCheckNames = failing;
    base.failingChecks = failing.length;
    base.totalChecks = rollup.length;
  }
  return { ...base, ...rest };
}

function reqChecks(...names: string[]): RequiredCheck[] {
  return names.map((name) => ({ name, acceptedConclusions: ["success"] }));
}

function protocolWith(over: Partial<MergeProtocol>): MergeProtocol {
  return { ...DEFAULT_MERGE_PROTOCOL, ...over };
}

interface MergeCase {
  name: string;
  state: Partial<PrState> & { rollup?: { name: string; conclusion: string }[] };
  protocol?: MergeProtocol;
  want: Mergeability;
}

const MERGE_CASES: MergeCase[] = [
  // The exact defect: UNSTABLE + a red DECLARED-required check used to classify `ready` and merge.
  {
    name: "UNSTABLE + red declared-required check -> blocked (the #392 defect)",
    state: { mergeStateStatus: "UNSTABLE", rollup: [{ name: "test (22.x, simple)", conclusion: "FAILURE" }] },
    protocol: protocolWith({ requiredChecks: [{ name: "test (22.x, simple)", acceptedConclusions: ["success"] }] }),
    want: "blocked",
  },
  {
    name: "CLEAN + red declared-required check -> blocked (backstop runs before the switch)",
    state: { mergeStateStatus: "CLEAN", rollup: [{ name: "build", conclusion: "FAILURE" }] },
    protocol: protocolWith({ requiredChecks: reqChecks("build") }),
    want: "blocked",
  },
  {
    name: "declared-required check pending -> waiting",
    state: { mergeStateStatus: "CLEAN", rollup: [{ name: "build", conclusion: "IN_PROGRESS" }] },
    protocol: protocolWith({ requiredChecks: reqChecks("build") }),
    want: "waiting",
  },
  {
    name: "declared-required check absent from head -> waiting (absence is not a pass)",
    state: { mergeStateStatus: "CLEAN", rollup: [{ name: "lint", conclusion: "SUCCESS" }] },
    protocol: protocolWith({ requiredChecks: reqChecks("build") }),
    want: "waiting",
  },
  {
    name: "declared-required check passing, CLEAN -> ready",
    state: { mergeStateStatus: "CLEAN", rollup: [{ name: "build", conclusion: "SUCCESS" }] },
    protocol: protocolWith({ requiredChecks: reqChecks("build") }),
    want: "ready",
  },
  {
    name: "declared-required check passing, UNSTABLE -> ready (falls through to the switch)",
    state: { mergeStateStatus: "UNSTABLE", rollup: [{ name: "build", conclusion: "SUCCESS" }] },
    protocol: protocolWith({ requiredChecks: reqChecks("build") }),
    want: "ready",
  },
  {
    name: "non-required check failing (not declared-required), UNSTABLE -> ready (today's behaviour)",
    state: {
      mergeStateStatus: "UNSTABLE",
      rollup: [{ name: "build", conclusion: "SUCCESS" }, { name: "flaky-optional", conclusion: "FAILURE" }],
    },
    protocol: protocolWith({ requiredChecks: reqChecks("build") }),
    want: "ready",
  },
  {
    name: "CANCELLED superseded by a newer green run on a required check -> ready (#348 semantics)",
    // `prState`'s rollup shorthand keeps one conclusion per name (latest wins); model the superseded
    // + re-run by asserting the green outcome the rollup helpers collapse to.
    state: { mergeStateStatus: "UNSTABLE", rollup: [{ name: "engine-core", conclusion: "SUCCESS" }] },
    protocol: protocolWith({ requiredChecks: reqChecks("engine-core") }),
    want: "ready",
  },
  {
    name: "acceptedConclusions beyond [success] honoured: NEUTRAL accepted -> ready",
    state: { mergeStateStatus: "CLEAN", rollup: [{ name: "build", conclusion: "NEUTRAL" }] },
    protocol: protocolWith({ requiredChecks: [{ name: "build", acceptedConclusions: ["success", "neutral"] }] }),
    want: "ready",
  },
  {
    name: "acceptedConclusions [success] does NOT accept a NEUTRAL required conclusion -> blocked",
    state: { mergeStateStatus: "CLEAN", rollup: [{ name: "build", conclusion: "NEUTRAL" }] },
    protocol: protocolWith({ requiredChecks: [{ name: "build", acceptedConclusions: ["success"] }] }),
    want: "blocked",
  },
  {
    name: "waitForChecks:true + pending required check -> waiting even when CLEAN",
    state: { mergeStateStatus: "CLEAN", rollup: [{ name: "build", conclusion: "QUEUED" }] },
    protocol: protocolWith({ requiredChecks: reqChecks("build"), waitForChecks: true }),
    want: "waiting",
  },
];

for (const c of MERGE_CASES) {
  test(`classifyMergeability: ${c.name}`, () => {
    assertEquals(classifyMergeability(mergePrState(c.state), c.protocol), c.want);
  });
}

// Empty requiredChecks (the DEFAULT protocol) — behaviour must be IDENTICAL to today across every
// mergeStateStatus, whether a protocol is passed or omitted entirely.
const DEFAULT_BEHAVIOUR: { status: string; failingChecks?: number; want: Mergeability }[] = [
  { status: "CLEAN", want: "ready" },
  { status: "HAS_HOOKS", want: "ready" },
  { status: "UNSTABLE", want: "ready" },
  { status: "BEHIND", want: "ready" },
  { status: "DIRTY", want: "conflict" },
  { status: "BLOCKED", failingChecks: 1, want: "blocked" },
  { status: "BLOCKED", failingChecks: 0, want: "waiting" },
  { status: "UNKNOWN", want: "waiting" },
  { status: "", want: "waiting" },
];

for (const c of DEFAULT_BEHAVIOUR) {
  test(`classifyMergeability: empty requiredChecks keeps today's behaviour (${c.status || "''"} -> ${c.want})`, () => {
    const s = prState({ mergeStateStatus: c.status, failingChecks: c.failingChecks ?? 0 });
    // Explicit default protocol and omitted-protocol must agree.
    assertEquals(classifyMergeability(s, DEFAULT_MERGE_PROTOCOL), c.want);
    assertEquals(classifyMergeability(s), c.want);
  });
}

// Token mode: the transport can't enumerate checks (`failingChecks === -1`, empty per-check lists),
// so even a repo that declares requiredChecks must fall through to today's `mergeStateStatus`
// behaviour — the backstop must NEVER newly block or wait when checks are unenumerable.
const TOKEN_MODE: { status: string; want: Mergeability }[] = [
  { status: "CLEAN", want: "ready" },
  { status: "UNSTABLE", want: "ready" },
  { status: "BLOCKED", want: "waiting" }, // failingChecks<0 → conservative wait, exactly as before
  { status: "DIRTY", want: "conflict" },
  { status: "UNKNOWN", want: "waiting" },
];

for (const c of TOKEN_MODE) {
  test(`classifyMergeability: token mode falls through, never newly blocks (${c.status} -> ${c.want})`, () => {
    const s = prState({
      mergeStateStatus: c.status,
      failingChecks: -1,
      totalChecks: -1,
      presentCheckNames: [],
      pendingCheckNames: [],
      checkConclusions: {},
    });
    const protocol = protocolWith({ requiredChecks: reqChecks("build"), waitForChecks: true });
    assertEquals(classifyMergeability(s, protocol), c.want);
  });
}

// ── Draft PRs are never landable (issue #454) ────────────────────────────────────────────────────
//
// A draft PR with green checks reports `mergeStateStatus: CLEAN`, so the old `mergeStateStatus`
// switch classified it `"ready"` → the poller attempted the merge → GitHub refused it (draft) → a
// misleading "the merge attempt did not land (result: blocked), investigate why GitHub refused"
// escalation. A draft is *categorically* not landable regardless of checks, and the remedy is
// always the same (mark it ready), so `isDraft` outranks every other signal and yields a
// first-class `"draft"` verdict the model can escalate with an actionable message.
test("classifyMergeability: a draft PR is never ready — even with green checks (issue #454)", () => {
  // CLEAN + green rollup would be `"ready"` if `isDraft` were ignored.
  assertEquals(classifyMergeability(mergePrState({ mergeStateStatus: "CLEAN", isDraft: true })), "draft");
  assertEquals(
    classifyMergeability(
      mergePrState({ mergeStateStatus: "CLEAN", isDraft: true, rollup: [{ name: "build", conclusion: "SUCCESS" }] }),
      protocolWith({ requiredChecks: reqChecks("build") }),
    ),
    "draft",
  );
});

test("classifyMergeability: draft outranks every mergeStateStatus (issue #454)", () => {
  for (const status of ["CLEAN", "HAS_HOOKS", "UNSTABLE", "BEHIND", "DIRTY", "BLOCKED", "UNKNOWN", ""]) {
    assertEquals(
      classifyMergeability(prState({ mergeStateStatus: status, isDraft: true })),
      "draft",
      `draft should outrank ${status || "''"}`,
    );
  }
});

test("classifyMergeability: a non-draft PR is unaffected (regression guard, issue #454)", () => {
  assertEquals(classifyMergeability(prState({ mergeStateStatus: "CLEAN", isDraft: false })), "ready");
});

// `checkConclusions` must report a terminal conclusion per check but normalise a STILL-IN-FLIGHT run
// to "" for BOTH rollup shapes — a CheckRun whose `status` is not COMPLETED, and a legacy
// StatusContext whose `state` is PENDING/EXPECTED — so a caller never mistakes a pending
// status-context's upper-cased `state` (e.g. "PENDING") for a terminal conclusion.
test("checkConclusions: in-flight runs map to '' for both CheckRun and StatusContext shapes", () => {
  const got = checkConclusions([
    { name: "ci-success", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "ci-failure", status: "COMPLETED", conclusion: "FAILURE" },
    { name: "ci-running", status: "IN_PROGRESS" }, // CheckRun in flight -> ""
    { name: "ci-queued", status: "QUEUED" }, // CheckRun queued -> ""
    { context: "legacy-pending", state: "PENDING" }, // StatusContext in flight -> ""
    { context: "legacy-expected", state: "EXPECTED" }, // StatusContext in flight -> ""
    { context: "legacy-error", state: "ERROR" }, // StatusContext terminal -> preserved
  ]);
  assertEquals(got, {
    "ci-success": "SUCCESS",
    "ci-failure": "FAILURE",
    "ci-running": "",
    "ci-queued": "",
    "legacy-pending": "",
    "legacy-expected": "",
    "legacy-error": "ERROR",
  });
});
