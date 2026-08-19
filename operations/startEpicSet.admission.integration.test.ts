// Integration + unit coverage for the SET/BATCH admission door (issue #292, slice S2) — driven
// through the operation EDGE `startEpicSet`. Proves the all-or-nothing admission contract:
//   • a valid DAG of epics admits every member AND stages every edge into `admitted_plan_deps`
//     (S2's FK-free staging), writing NOTHING to the durable `plans` / `plan_deps` graph (that is S3);
//   • a submitted cycle is rejected at the offending edge with NO partial start / NO edge staged;
//   • an edge naming an epic outside the set is a clean 400;
//   • a per-epic admission failure (base rules / shared-base) maps to the same 4xx as the single door;
//   • re-submitting the identical set is a no-op (no duplicate edge, no double-admit).
// It runs the real delegate against an in-memory app/data/engine and a faked github transport, exactly
// like startPlanFanout.admission.integration.test.ts — no network, deterministic on a single run.
// A SQLite-backed FK regression (foreign_keys=ON, migrations 041+043 applied) additionally proves S2
// admits with NO `plans` row present and stages FK-free, never FK-failing on `plan_deps`.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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
// The delegate reads `plans` (admitPlan's shared-base guard) and STAGES into `admitted_epics` +
// `admitted_plan_deps` (recordAdmittedEpic / recordAdmittedPlanDep) — it never writes the durable
// `plan_deps`. `admitted_plan_deps` is keyed on `plan_key` but holds MANY rows per key (composite
// edge), so the generic table's `get` (first row for the key) is not used for it — the delegate only
// `find`s + `insert`s.
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
// S2 stages into `admitted_plan_deps` / `admitted_epics` and must NEVER touch the durable `plan_deps`.
const admittedDepRows = (tables: Map<string, Record<string, unknown>[]>) =>
  tables.get("admitted_plan_deps") ?? [];
const admittedEpicRows = (tables: Map<string, Record<string, unknown>[]>) =>
  tables.get("admitted_epics") ?? [];
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
    // S2 admits + STAGES (epics and edges); S3 (this slice) then reads that staging and LOWERS the
    // set — starting every epic (roots immediately, dependents behind a seeded capability preflight)
    // and materializing the durable `plan_deps` graph after the `plans` rows exist.
    assertEquals(started.length, 2); // both epics started by the S3 lowering
    assertEquals(planDepsRows(tables).length, 1); // durable edge materialized by S3
    const epicRows = admittedEpicRows(tables);
    assertEquals(epicRows.length, 2); // both epics staged (roots included) then materialized
    const rows = admittedDepRows(tables);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].plan_key, `${REPO}#2`);
    assertEquals(rows[0].depends_on_plan_key, `${REPO}#1`);
    assertEquals(rows[0].package, "@scope/pkg");
    assertEquals(rows[0].capability_ref, `${REPO}#1`);
    // The dependent (#2) is seeded with a capability probe + bounded timeout; the root (#1) starts
    // with none so it fans out immediately.
    const startedByKey = new Map(started.map((s) => [s.variables?.["planKey"], s.variables ?? {}]));
    const rootVars = startedByKey.get(`${REPO}#1`);
    const depVars = startedByKey.get(`${REPO}#2`);
    assertEquals(rootVars?.["readinessProbes"], null);
    assertEquals(Array.isArray(depVars?.["readinessProbes"]), true);
    assertEquals((depVars?.["readinessProbes"] as unknown[]).length, 1);
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
    assertEquals(admittedDepRows(tables).length, 0);
    assertEquals(admittedEpicRows(tables).length, 2); // both roots staged
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
    assertEquals(admittedDepRows(tables).length, 0); // nothing staged
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
    assertEquals(admittedDepRows(tables).length, 0);
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
    assertEquals(admittedDepRows(tables).length, 0); // edges staged only after ALL epics admit
    assertEquals(admittedEpicRows(tables).length, 0); // no epic staged on a partial-admit reject
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

// ── Intra-set shared-base collision: two members reaching for the SAME custom base ───────────────
// admitPlan's rule 4 only sees DURABLE `plans` rows, and S2 materializes none, so without an
// in-request guard two epics in one set could both grab the same custom integration branch and
// silently defeat ADR 0003 rule 4. The door must reject the collision itself, all-or-nothing.
test("intra-set: two epics on the same custom base, neither opting in → 409, nothing staged", async () => {
  const gh = freshGithub(REPO, ["epic/shared"]);
  await withGithub(gh, async () => {
    const { app, tables } = makeApp();
    const res = await call(app, {
      epics: [
        { issue: `${REPO}#1`, baseBranch: "epic/shared" },
        { issue: `${REPO}#2`, baseBranch: "epic/shared" },
      ],
    });
    assertEquals(res.status, 409);
    assertEquals(typeof res.body.error, "string");
    assertEquals(admittedEpicRows(tables).length, 0); // all-or-nothing: nothing staged on reject
    assertEquals(admittedDepRows(tables).length, 0);
  });
});

test("intra-set: same custom base admitted when the later epic opts in with allowSharedBase", async () => {
  const gh = freshGithub(REPO, ["epic/shared"]);
  await withGithub(gh, async () => {
    const { app, tables } = makeApp();
    const res = await call(app, {
      epics: [
        { issue: `${REPO}#1`, baseBranch: "epic/shared" },
        { issue: `${REPO}#2`, baseBranch: "epic/shared", allowSharedBase: true },
      ],
    });
    assertEquals(res.status, 202);
    assertEquals(admittedEpicRows(tables).length, 2);
  });
});

test("intra-set: two epics on the DEFAULT base (both confirmed) do NOT collide", async () => {
  const gh = freshGithub(REPO);
  await withGithub(gh, async () => {
    const { app, tables } = makeApp();
    const res = await call(app, {
      epics: [
        { issue: `${REPO}#1`, baseBranch: "main", confirmDefaultBase: true },
        { issue: `${REPO}#2`, baseBranch: "main", confirmDefaultBase: true },
      ],
    });
    assertEquals(res.status, 202); // default branch is exempt from the shared-base guard (rule 3/4)
    assertEquals(admittedEpicRows(tables).length, 2);
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
    assertEquals(admittedDepRows(tables).length, 1);
    assertEquals(admittedEpicRows(tables).length, 2);
    const second = await call(app, set);
    assertEquals(second.status, 202);
    assertEquals(admittedDepRows(tables).length, 1); // no duplicate edge on retry
    assertEquals(admittedEpicRows(tables).length, 2); // no duplicate epic on retry
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

// `deps`, when provided, MUST be an array. A non-array `deps` (e.g. an object) must be a clean 400,
// not silently coerced to `[]` — which would admit the set while dropping every declared edge.
test("non-array deps: 400, nothing admitted", async () => {
  const gh = freshGithub(REPO);
  await withGithub(gh, async () => {
    const { app } = makeApp();
    const res = await call(app, {
      epics: [{ issue: `${REPO}#1`, baseBranch: "epic/a" }],
      deps: { consumer: `${REPO}#1`, producer: `${REPO}#1` },
    });
    assertEquals(res.status, 400);
    assertEquals(typeof res.body.error, "string");
    assertEquals(gh.creates, []); // rejected BEFORE any admitPlan side effect
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
      assertEquals(admittedDepRows(tables).length, 0);
      assertEquals(gh.creates, []); // rejected BEFORE any admitPlan side effect
    });
  });
}

// ── SQLite-backed FK regression (issue #292 S2) ──────────────────────────────────────────────────
// The in-memory data layer above does NOT enforce SQLite constraints — notably `plan_deps.plan_key`'s
// FK to `plans` (041). So it could not have caught the FK-violation the S2 door originally shipped:
// it wrote validated edges into `plan_deps` while admitting via `admitPlan` (which creates NO `plans`
// row), so a first-time set submission FK-failed (500). The fix (design decision on #292): S2 admits
// + STAGES into its own FK-free `admitted_epics` / `admitted_plan_deps` (043); S3 materializes the
// durable graph. These tests drive the real delegate against a real `node:sqlite` db with
// foreign_keys=ON and migrations 041+043 applied, proving the door no longer FK-fails and never
// writes `plan_deps`.

/** A DataLayer over a real in-memory SQLite db with foreign_keys ON, migrations 041+043 applied, and a
 * minimal `plans` shape (the columns admitPlan's shared-base guard reads + the PK 041's FK references).
 * Seeds NO plans rows by default — that is exactly the first-submission condition the old code
 * FK-failed on. */
function makeSqliteApp(
  seedPlans: { plan_key: string; repo: string; base_branch: string; status: string }[] = [],
) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(
    "CREATE TABLE plans (plan_key TEXT PRIMARY KEY, repo TEXT, issue_number INTEGER, issue_url TEXT, " +
      "title TEXT, base_branch TEXT, status TEXT, task_count INTEGER, epic_phase TEXT, " +
      "blackboard_token TEXT, list_bucket TEXT, ack_open INTEGER, created_at TEXT, updated_at TEXT);",
  );
  for (const p of seedPlans) {
    db.prepare("INSERT INTO plans (plan_key, repo, base_branch, status) VALUES (?, ?, ?, ?)")
      .run(p.plan_key, p.repo, p.base_branch, p.status);
  }
  for (const f of ["041_inter_epic_plan_deps.sql", "045_epic_set_admission_staging.sql"]) {
    db.exec(readFileSync(fileURLToPath(new URL(`../db/migrations/${f}`, import.meta.url)), "utf8"));
  }
  const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
  const coerce = (v: unknown) => (v === null ? null : typeof v === "boolean" ? (v ? 1 : 0) : v) as any;
  const table = (name: string, key: string) => ({
    get: (k: unknown) =>
      Promise.resolve(db.prepare(`SELECT * FROM ${q(name)} WHERE ${q(key)} = ?`).get(coerce(k)) ?? null),
    find: (query: Record<string, unknown>) => {
      const keys = Object.keys(query);
      const clause = keys.length ? `WHERE ${keys.map((k) => `${q(k)} = ?`).join(" AND ")}` : "";
      return Promise.resolve(db.prepare(`SELECT * FROM ${q(name)} ${clause}`).all(...keys.map((k) => coerce(query[k]))));
    },
    insert: (r: Record<string, unknown>) => {
      const keys = Object.keys(r).filter((k) => r[k] !== undefined);
      db.prepare(`INSERT INTO ${q(name)} (${keys.map(q).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
        .run(...keys.map((k) => coerce(r[k])));
      return Promise.resolve(r);
    },
    update: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
  });
  const app = {
    data: { table },
    engine: { createInstance: () => Promise.resolve({ processInstanceKey: "PI-1" }) },
    log: noopLog(),
  } as any as AppApi;
  return { app, db };
}

test("SQLite (FK ON): admits a set with NO plans row, then S3 lowering starts plans FK-first and materializes plan_deps", async () => {
  const gh = freshGithub(REPO);
  await withGithub(gh, async () => {
    const { app, db } = makeSqliteApp(); // no plans rows — the first-submission FK-failure condition
    try {
      const res = await call(app, {
        epics: [
          { issue: `${REPO}#1`, baseBranch: "epic/producer" },
          { issue: `${REPO}#2`, baseBranch: "epic/consumer" },
        ],
        deps: [{ consumer: `${REPO}#2`, producer: `${REPO}#1`, package: "@scope/pkg", capabilityRef: `${REPO}#1` }],
      });
      // Under the old code this was a 500 FK violation on `plan_deps.plan_key`. S3 lowering inserts
      // BOTH `plans` rows before recording the edge, so the durable `plan_deps` FK is satisfied.
      assertEquals(res.status, 202);
      const planN = db.prepare("SELECT COUNT(*) AS n FROM plans").get() as { n: number };
      assertEquals(planN.n, 2); // both epics materialized a plans row
      const planDepN = db.prepare("SELECT COUNT(*) AS n FROM plan_deps").get() as { n: number };
      assertEquals(planDepN.n, 1); // durable edge materialized FK-clean by S3
      const staged = db
        .prepare("SELECT plan_key, depends_on_plan_key, package FROM admitted_plan_deps")
        .all() as { plan_key: string; depends_on_plan_key: string; package: string }[];
      assertEquals(staged.length, 1);
      assertEquals(staged[0].plan_key, `${REPO}#2`);
      assertEquals(staged[0].depends_on_plan_key, `${REPO}#1`);
      const epicN = db.prepare("SELECT COUNT(*) AS n FROM admitted_epics").get() as { n: number };
      assertEquals(epicN.n, 2); // both epics staged for S3 to materialize
    } finally {
      db.close();
    }
  });
});

test("SQLite: plan_deps FK rejects an unbacked edge, but the admitted_plan_deps staging twin accepts it", () => {
  const { db } = makeSqliteApp();
  try {
    const edge = (t: string) =>
      `INSERT INTO ${t} (plan_key, depends_on_plan_key, package, capability_ref, created_at) VALUES ('o/r#2','o/r#1','p','o/r#1','t')`;
    let fkThrew = false;
    try {
      db.prepare(edge("plan_deps")).run(); // no plans row for o/r#2 → FK violation
    } catch {
      fkThrew = true;
    }
    assertEquals(fkThrew, true); // proves plan_deps.plan_key REFERENCES plans(plan_key) is real + ON
    db.prepare(edge("admitted_plan_deps")).run(); // FK-free staging twin accepts the same unbacked edge
    const n = db.prepare("SELECT COUNT(*) AS n FROM admitted_plan_deps").get() as { n: number };
    assertEquals(n.n, 1);
  } finally {
    db.close();
  }
});

