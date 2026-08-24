// Integration coverage for the base-branch ADMISSION gate (ADR 0003) driven through the operation
// EDGE — `startPlanFanout` → `admitPlan` → HTTP status. The unit tests in app/plan.test.ts already
// prove `admitPlan`'s decision matrix in isolation; this file proves the COMPOSED behaviour at the
// door: each admission rule maps to the correct HTTP status (400 / 409) and each accept path reaches
// the 202 fan-out. It runs the real delegate against an in-memory app/data/engine and a faked github
// transport (token mode + stubbed `globalThis.fetch`) — no network, deterministic on a single run.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { resetDefaultBranchCache } from "../app/github.ts";
import { noopLog } from "../test/log.ts";
import { withTrackingViews } from "../test/trackingViews.ts";
import startPlanFanout from "./startPlanFanout.ts";

// ── in-memory github model ───────────────────────────────────────────────────
// A minimal fake of the GitHub REST surface `admitPlan` touches: the repo-meta GET (default branch),
// the ref GET (branch existence, returning a synthetic per-branch head sha) and the ref-create POST.
// `default_branch` is `main`; a missing `epic/*` base is auto-created off the default branch's head
// sha (which `admitPlan` reads via the ref GET, so here that is `main-sha`). `creates` records the
// full ref-create POST body (`ref` + `sha`) so a test can assert a branch was (or was NOT) created
// AND that the create payload points the new ref at the resolved base sha, not a stale/blank value.
interface GithubState {
  repo: string;
  defaultBranch: string;
  branches: Set<string>;
  creates: { ref: string; sha: string }[];
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
      if (!state.branches.has(branch)) return Promise.resolve(new Response("Not Found", { status: 404 }));
      return Promise.resolve(json({ ref: `refs/heads/${branch}`, object: { sha: `${branch}-sha` } }));
    }
    if (method === "POST" && path === `/repos/${state.repo}/git/refs`) {
      // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
      const body = JSON.parse(String(init?.body ?? "{}")) as { ref?: string; sha?: string };
      const ref = String(body.ref ?? "");
      const sha = String(body.sha ?? "");
      const branch = ref.replace(/^refs\/heads\//, "");
      if (state.branches.has(branch)) return Promise.resolve(json({ message: "Reference already exists" }, 422));
      state.creates.push({ ref, sha });
      state.branches.add(branch);
      return Promise.resolve(json({ ref }, 201));
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
  resetDefaultBranchCache(); // isolate: don't inherit or leak another test's default-branch entry
  globalThis.fetch = githubFetch(state) as typeof fetch;
  try {
    return await fn();
  } finally {
    resetDefaultBranchCache();
    globalThis.fetch = prevFetch;
    if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
    if (prevTok === undefined) delete process.env["GITHUB_TOKEN"];
    else process.env["GITHUB_TOKEN"] = prevTok;
  }
}

// ── in-memory app (data + engine) ────────────────────────────────────────────
// A generic table over an array, matching the DataLayer surface `startPlan`/`findActivePlansByBase`
// use (get/find/insert/update/delete). `seedPlans` pre-loads the `plans` table so the shared-base
// guard has active rows to find. `started` records each engine.createInstance call so an accept path
// can be asserted to have fanned out.
function makeApp(seedPlans: Record<string, unknown>[] = []) {
  const tables = new Map<string, Record<string, unknown>[]>();
  tables.set("plans", [...seedPlans]);
  const started: { processDefinitionId: string; variables?: Record<string, unknown> }[] = [];
  const table = (name: string, key: string) => {
    const rows = tables.get(name) ?? (() => {
      const fresh: Record<string, unknown>[] = [];
      tables.set(name, fresh);
      return fresh;
    })();
    return {
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
    };
  };
  const app = {
    data: { table: withTrackingViews(table) },
    engine: {
      createInstance: (req: { processDefinitionId: string; variables?: Record<string, unknown> }) => {
        started.push(req);
        return Promise.resolve({ processInstanceKey: "PI-1" });
      },
    },
    log: noopLog(),
  } as any as AppApi;
  return { app, started };
}

function input(body: unknown) {
  return {
    req: { method: "POST", path: "/", query: new URLSearchParams(), headers: new Headers(), text: async () => "" } as any,
    params: {},
    query: {},
    body,
  };
}

function freshGithub(repo: string, extraBranches: string[] = []): GithubState {
  return { repo, defaultBranch: "main", branches: new Set(["main", ...extraBranches]), creates: [] };
}

// ── Rule 1 — required + explicit ──────────────────────────────────────────────

// Rule 1 rejects both a MISSING baseBranch field and an explicit blank/whitespace
// one — the latter is a distinct edge input that must not slip past as a "present"
// value. Table-drive both so the required-and-explicit rule is covered end to end.
for (const [label, body] of [
  ["missing field", { issue: "owner/repo#1" }],
  ["empty string", { issue: "owner/repo#1", baseBranch: "" }],
  ["whitespace only", { issue: "owner/repo#1", baseBranch: "   " }],
] as const) {
  test(`edge: ${label} baseBranch → 400`, async () => {
    const gh = freshGithub("owner/repo");
    await withGithub(gh, async () => {
      const { app, started } = makeApp();
      const res = (await startPlanFanout(input(body), app)) as any;
      assertEquals(res.status, 400);
      assertEquals(typeof res.body.error, "string");
      assertEquals(started.length, 0); // rejected before any fan-out
      assertEquals(gh.creates, []); // no ref created on a rejected input
    });
  });
}

// ── Rule 2 — create-if-missing (epic/* guard), synchronously at the edge ──────

test("edge: non-epic/* base that does not exist → 400 (BaseBranchMustExistError path)", async () => {
  // A typo'd, non-epic/* base is NOT auto-created — admitPlan throws BaseBranchMustExistError
  // synchronously, which the delegate maps to a clean 400 at the door (not a late per-task failure).
  const gh = freshGithub("owner/repo"); // "release-9" absent, not epic/* → must-exist
  await withGithub(gh, async () => {
    const { app, started } = makeApp();
    const res = (await startPlanFanout(input({ issue: "owner/repo#2", baseBranch: "release-9" }), app)) as any;
    assertEquals(res.status, 400);
    assertEquals(typeof res.body.error, "string");
    assertEquals(started.length, 0);
    assertEquals(gh.creates, []); // never created
  });
});

test("edge: missing epic/* base → created off default HEAD, then 202", async () => {
  const gh = freshGithub("owner/repo"); // epic/new absent → auto-created off main
  await withGithub(gh, async () => {
    const { app, started } = makeApp();
    const res = (await startPlanFanout(input({ issue: "owner/repo#3", baseBranch: "epic/new" }), app)) as any;
    assertEquals(res.status, 202);
    // Created off the resolved base sha: the ref-create payload names epic/new AND points it at the
    // default branch's head sha (`main-sha` here), proving the create body carries the base sha.
    assertEquals(gh.creates, [{ ref: "refs/heads/epic/new", sha: "main-sha" }]);
    assertEquals(started.length, 1);
  });
});

// ── Rule 3 — confirm-default ──────────────────────────────────────────────────

test("edge: target == default branch WITHOUT confirmDefaultBase → 400", async () => {
  const gh = freshGithub("owner/repo"); // base "main" IS the default
  await withGithub(gh, async () => {
    const { app, started } = makeApp();
    const res = (await startPlanFanout(input({ issue: "owner/repo#4", baseBranch: "main" }), app)) as any;
    assertEquals(res.status, 400);
    assertEquals(typeof res.body.error, "string");
    assertEquals(started.length, 0);
  });
});

test("edge: target == default branch WITH confirmDefaultBase → 202", async () => {
  const gh = freshGithub("owner/repo");
  await withGithub(gh, async () => {
    const { app, started } = makeApp();
    const res = (await startPlanFanout(
      input({ issue: "owner/repo#5", baseBranch: "main", confirmDefaultBase: true }),
      app,
    )) as any;
    assertEquals(res.status, 202);
    assertEquals(started.length, 1);
  });
});

// ── Rule 4 — shared-base guard ────────────────────────────────────────────────

test("edge: active plan on the same CUSTOM base WITHOUT allowSharedBase → 409", async () => {
  const gh = freshGithub("owner/repo", ["epic/shared"]); // base exists → ensureBaseBranch no-ops
  await withGithub(gh, async () => {
    // A DIFFERENT active plan already targets epic/shared on this repo.
    const { app, started } = makeApp([
      { plan_key: "owner/repo#98", repo: "owner/repo", base_branch: "epic/shared", status: "planning" },
    ]);
    const res = (await startPlanFanout(input({ issue: "owner/repo#6", baseBranch: "epic/shared" }), app)) as any;
    assertEquals(res.status, 409);
    assertEquals(typeof res.body.error, "string");
    assertEquals(started.length, 0);
  });
});

test("edge: same CUSTOM base WITH allowSharedBase → 202", async () => {
  const gh = freshGithub("owner/repo", ["epic/shared"]);
  await withGithub(gh, async () => {
    const { app, started } = makeApp([
      { plan_key: "owner/repo#98", repo: "owner/repo", base_branch: "epic/shared", status: "planning" },
    ]);
    const res = (await startPlanFanout(
      input({ issue: "owner/repo#7", baseBranch: "epic/shared", allowSharedBase: true }),
      app,
    )) as any;
    assertEquals(res.status, 202);
    assertEquals(started.length, 1);
  });
});

test("edge: two plans sharing the DEFAULT branch → 202 (default is exempt from the shared-base guard)", async () => {
  const gh = freshGithub("owner/repo"); // base "main" == default → exempt
  await withGithub(gh, async () => {
    // An active plan already targets main; a second one is still admitted (confirmed default).
    const { app, started } = makeApp([
      { plan_key: "owner/repo#97", repo: "owner/repo", base_branch: "main", status: "planning" },
    ]);
    const res = (await startPlanFanout(
      input({ issue: "owner/repo#8", baseBranch: "main", confirmDefaultBase: true }),
      app,
    )) as any;
    assertEquals(res.status, 202);
    assertEquals(started.length, 1);
  });
});
