// Integration + unit coverage for the SET/BATCH admission door (issue #292, slice S2) — driven
// through the operation EDGE `startEpicSet`. Proves the all-or-nothing admission contract:
//   • a valid DAG of epics admits every member AND persists every edge into plan_deps;
//   • a submitted cycle is rejected at the offending edge with NO partial start / NO edge persisted;
//   • an edge naming an epic outside the set is a clean 400;
//   • a per-epic admission failure (base rules / shared-base) maps to the same 4xx as the single door;
//   • re-submitting the identical set is a no-op (no duplicate edge, no double-admit).
// It runs the real delegate against an in-memory app/data/engine and a faked github transport, exactly
// like startPlanFanout.admission.integration.test.ts — no network, deterministic on a single run.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { resetDefaultBranchCache } from "../app/github.ts";
import { noopLog } from "../test/log.ts";
import startEpicSet from "./startEpicSet.ts";

// ── in-memory github model (mirrors startPlanFanout.admission.integration.test.ts) ───────────────
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
      const bodyObj = JSON.parse(String(init?.body ?? "{}")) as { ref?: string; sha?: string };
      const ref = String(bodyObj.ref ?? "");
      const sha = String(bodyObj.sha ?? "");
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
  resetDefaultBranchCache();
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

// ── in-memory app (data + engine) ────────────────────────────────────────────────────────────────
// The delegate reads/writes `plans` (admitPlan's shared-base guard) and `plan_deps` (recordPlanDep).
// `plan_deps` is keyed on `plan_key` but holds MANY rows per key (composite edge), so the generic
// table's `get` (first row for the key) is not used for it — the delegate only `find`s + `insert`s.
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
    data: { table },
    engine: {
      createInstance: (req: { processDefinitionId: string; variables?: Record<string, unknown> }) => {
        started.push(req);
        return Promise.resolve({ processInstanceKey: "PI-1" });
      },
    },
    log: noopLog(),
  } as any as AppApi;
  return { app, started, tables };
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

const REPO = "owner/repo";
const call = (app: AppApi, body: unknown) => startEpicSet(input(body), app) as Promise<any>;
const planDepsRows = (tables: Map<string, Record<string, unknown>[]>) => tables.get("plan_deps") ?? [];

// ── Happy path: a valid DAG admits every member and persists every edge ──────────────────────────
test("valid DAG: admits all epics and persists all edges", async () => {
  const gh = freshGithub(REPO); // epic/* bases auto-created
  await withGithub(gh, async () => {
    const { app, started, tables } = makeApp();
    const res = await call(app, {
      epics: [
        { issue: `${REPO}#1`, baseBranch: "epic/producer" },
        { issue: `${REPO}#2`, baseBranch: "epic/consumer" },
      ],
      deps: [{ consumer: `${REPO}#2`, producer: `${REPO}#1`, package: "@scope/pkg", capabilityRef: `${REPO}#1` }],
    });
    assertEquals(res.status, 202);
    assertEquals(res.body.epics.length, 2);
    assertEquals(res.body.roots, [`${REPO}#1`]); // #1 has no inbound edge
    assertEquals(res.body.edges, [
      { consumer: `${REPO}#2`, producer: `${REPO}#1`, package: "@scope/pkg", capabilityRef: `${REPO}#1` },
    ]);
    // S2 admits + persists edges but NEVER starts an epic (that is S3).
    assertEquals(started.length, 0);
    const rows = planDepsRows(tables);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].plan_key, `${REPO}#2`);
    assertEquals(rows[0].depends_on_plan_key, `${REPO}#1`);
    assertEquals(rows[0].package, "@scope/pkg");
    assertEquals(rows[0].capability_ref, `${REPO}#1`);
  });
});

test("independent roots: a set with no deps admits every epic as a root, no edges", async () => {
  const gh = freshGithub(REPO);
  await withGithub(gh, async () => {
    const { app, tables } = makeApp();
    const res = await call(app, {
      epics: [
        { issue: `${REPO}#1`, baseBranch: "epic/a" },
        { issue: `${REPO}#2`, baseBranch: "epic/b" },
      ],
    });
    assertEquals(res.status, 202);
    assertEquals(res.body.roots.sort(), [`${REPO}#1`, `${REPO}#2`]);
    assertEquals(res.body.edges, []);
    assertEquals(planDepsRows(tables).length, 0);
  });
});

// ── Cycle: rejected at the offending edge, nothing half-started ──────────────────────────────────
test("cycle: rejected 400 with no edge persisted and no branch created", async () => {
  const gh = freshGithub(REPO);
  await withGithub(gh, async () => {
    const { app, tables } = makeApp();
    const res = await call(app, {
      epics: [
        { issue: `${REPO}#1`, baseBranch: "epic/a" },
        { issue: `${REPO}#2`, baseBranch: "epic/b" },
      ],
      deps: [
        { consumer: `${REPO}#2`, producer: `${REPO}#1`, package: "p", capabilityRef: `${REPO}#1` },
        { consumer: `${REPO}#1`, producer: `${REPO}#2`, package: "p", capabilityRef: `${REPO}#2` },
      ],
    });
    assertEquals(res.status, 400);
    assertEquals(typeof res.body.error, "string");
    assertEquals(planDepsRows(tables).length, 0); // nothing persisted
    assertEquals(gh.creates, []); // cycle rejected BEFORE any admitPlan side effect
  });
});

// ── Dangling edge: an endpoint not in the set is a clean 400, before admission ───────────────────
test("edge naming an epic outside the set: 400, nothing persisted/created", async () => {
  const gh = freshGithub(REPO);
  await withGithub(gh, async () => {
    const { app, tables } = makeApp();
    const res = await call(app, {
      epics: [{ issue: `${REPO}#1`, baseBranch: "epic/a" }],
      deps: [{ consumer: `${REPO}#1`, producer: `${REPO}#999`, package: "p", capabilityRef: `${REPO}#999` }],
    });
    assertEquals(res.status, 400);
    assertEquals(typeof res.body.error, "string");
    assertEquals(planDepsRows(tables).length, 0);
    assertEquals(gh.creates, []);
  });
});

test("self-edge: 400", async () => {
  const gh = freshGithub(REPO);
  await withGithub(gh, async () => {
    const { app } = makeApp();
    const res = await call(app, {
      epics: [{ issue: `${REPO}#1`, baseBranch: "epic/a" }],
      deps: [{ consumer: `${REPO}#1`, producer: `${REPO}#1`, package: "p", capabilityRef: `${REPO}#1` }],
    });
    assertEquals(res.status, 400);
  });
});

// ── Per-epic admission failure maps to the same 4xx as the single door, nothing persisted ────────
test("unadmittable epic (default base without confirm): 400, no edge persisted", async () => {
  const gh = freshGithub(REPO);
  await withGithub(gh, async () => {
    const { app, tables } = makeApp();
    const res = await call(app, {
      epics: [
        { issue: `${REPO}#1`, baseBranch: "epic/ok" },
        { issue: `${REPO}#2`, baseBranch: "main" }, // default branch without confirmDefaultBase → 400
      ],
      deps: [{ consumer: `${REPO}#2`, producer: `${REPO}#1`, package: "p", capabilityRef: `${REPO}#1` }],
    });
    assertEquals(res.status, 400);
    assertEquals(planDepsRows(tables).length, 0); // edges persisted only after ALL epics admit
  });
});

test("shared custom base with an active plan: 409 (shared-base guard)", async () => {
  const gh = freshGithub(REPO, ["epic/shared"]);
  await withGithub(gh, async () => {
    const { app } = makeApp([
      { plan_key: `${REPO}#98`, repo: REPO, base_branch: "epic/shared", status: "planning" },
    ]);
    const res = await call(app, {
      epics: [{ issue: `${REPO}#1`, baseBranch: "epic/shared" }],
    });
    assertEquals(res.status, 409);
    assertEquals(typeof res.body.error, "string");
  });
});

// ── Idempotency: re-submitting the identical set records no duplicate edge ────────────────────────
test("idempotent: re-submitting the identical set does not duplicate edges", async () => {
  const gh = freshGithub(REPO);
  await withGithub(gh, async () => {
    const { app, tables } = makeApp();
    const set = {
      epics: [
        { issue: `${REPO}#1`, baseBranch: "epic/producer" },
        { issue: `${REPO}#2`, baseBranch: "epic/consumer" },
      ],
      deps: [{ consumer: `${REPO}#2`, producer: `${REPO}#1`, package: "@scope/pkg", capabilityRef: `${REPO}#1` }],
    };
    const first = await call(app, set);
    assertEquals(first.status, 202);
    assertEquals(planDepsRows(tables).length, 1);
    const second = await call(app, set);
    assertEquals(second.status, 202);
    assertEquals(planDepsRows(tables).length, 1); // no duplicate edge on retry
  });
});

// ── Malformed body / references ──────────────────────────────────────────────────────────────────
test("empty epics array: 400", async () => {
  const gh = freshGithub(REPO);
  await withGithub(gh, async () => {
    const { app } = makeApp();
    const res = await call(app, { epics: [] });
    assertEquals(res.status, 400);
  });
});

test("unparseable epic reference: 400", async () => {
  const gh = freshGithub(REPO);
  await withGithub(gh, async () => {
    const { app } = makeApp();
    const res = await call(app, { epics: [{ issue: "not-an-issue", baseBranch: "epic/a" }] });
    assertEquals(res.status, 400);
  });
});

// ── Reference extraction enforces EXACTLY-ONE-of issue|url (the operation contract) ──────────────
test("epic naming BOTH issue and url: 400, nothing created", async () => {
  const gh = freshGithub(REPO);
  await withGithub(gh, async () => {
    const { app } = makeApp();
    const res = await call(app, {
      epics: [{ issue: `${REPO}#1`, url: `https://github.com/${REPO}/issues/1`, baseBranch: "epic/a" }],
    });
    assertEquals(res.status, 400);
    assertEquals(typeof res.body.error, "string");
    assertEquals(gh.creates, []); // rejected BEFORE any admitPlan side effect
  });
});

test("epic with issue:null falls through to a valid url (key-presence must not win)", async () => {
  const gh = freshGithub(REPO);
  await withGithub(gh, async () => {
    const { app } = makeApp();
    const res = await call(app, {
      epics: [{ issue: null, url: `https://github.com/${REPO}/issues/7`, baseBranch: "epic/a" }],
    });
    assertEquals(res.status, 202);
    assertEquals(res.body.epics, [{ planKey: `${REPO}#7`, baseBranch: "epic/a" }]);
  });
});

test("epic with neither issue nor url (both null): 400", async () => {
  const gh = freshGithub(REPO);
  await withGithub(gh, async () => {
    const { app } = makeApp();
    const res = await call(app, { epics: [{ issue: null, url: null, baseBranch: "epic/a" }] });
    assertEquals(res.status, 400);
  });
});

test("missing body: 400", async () => {
  const gh = freshGithub(REPO);
  await withGithub(gh, async () => {
    const { app } = makeApp();
    const res = await call(app, undefined);
    assertEquals(res.status, 400);
  });
});

// ── Malformed deps[] entries map to a clean 400 (never an uncaught TypeError/500), nothing persisted.
// `deps` arrives from an untyped request body, so a null/non-object entry or a non-string field must
// be rejected as an EpicSetValidationError → 400, with no edge persisted and no branch created.
for (const [label, badDep] of [
  ["null entry", null],
  ["non-object entry (string)", "owner/repo#1"],
  ["empty object (missing endpoints)", {}],
  ["non-string consumer", { consumer: 1, producer: `${REPO}#1`, package: "p", capabilityRef: `${REPO}#1` }],
  ["non-string package", { consumer: `${REPO}#2`, producer: `${REPO}#1`, package: 7, capabilityRef: `${REPO}#1` }],
] as const) {
  test(`malformed dep (${label}): 400, nothing persisted/created`, async () => {
    const gh = freshGithub(REPO);
    await withGithub(gh, async () => {
      const { app, tables } = makeApp();
      const res = await call(app, {
        epics: [
          { issue: `${REPO}#1`, baseBranch: "epic/a" },
          { issue: `${REPO}#2`, baseBranch: "epic/b" },
        ],
        deps: [badDep],
      });
      assertEquals(res.status, 400);
      assertEquals(typeof res.body.error, "string");
      assertEquals(planDepsRows(tables).length, 0);
      assertEquals(gh.creates, []); // rejected BEFORE any admitPlan side effect
    });
  });
}

