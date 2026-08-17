// Red/green regression for the plan-review round-cap parsing (PR #26 review).
//
// `MAX_PLAN_REVIEW_ROUNDS` bounds the adversarial revise loop. If the env override parsed to
// `NaN`/`0` (e.g. unset, "", "abc"), the cap check `round + 1 >= cap` would never fire and the
// planner could revise forever. `positiveIntEnv` must fall back to the default on any value that
// is not a positive integer, so the loop is always bounded.
import { after, test } from "node:test";
import { assertEquals, assertRejects, assertThrows } from "#test-assert";
import { positiveIntEnv } from "./plan.ts";

const KEY = "NANO_PLAN_REVIEW_ROUNDS_TEST";

function withEnv(value: string | undefined, run: () => void) {
  const had = Object.prototype.hasOwnProperty.call(process.env, KEY);
  const prev = process.env[KEY];
  try {
    if (value === undefined) delete process.env[KEY];
    else process.env[KEY] = value;
    run();
  } finally {
    if (had && prev !== undefined) process.env[KEY] = prev;
    else delete process.env[KEY];
  }
}

test("unset → fallback (bounded loop, never NaN)", () => {
  withEnv(undefined, () => assertEquals(positiveIntEnv(KEY, 3), 3));
});

test("blank/whitespace → fallback, not 0", () => {
  withEnv("", () => assertEquals(positiveIntEnv(KEY, 3), 3));
  withEnv("   ", () => assertEquals(positiveIntEnv(KEY, 3), 3));
});

test("non-numeric → fallback, not NaN", () => {
  withEnv("abc", () => assertEquals(positiveIntEnv(KEY, 3), 3));
});

test("zero and negatives → fallback (cap must be >= 1)", () => {
  withEnv("0", () => assertEquals(positiveIntEnv(KEY, 3), 3));
  withEnv("-2", () => assertEquals(positiveIntEnv(KEY, 3), 3));
});

test("non-integer → fallback", () => {
  withEnv("2.5", () => assertEquals(positiveIntEnv(KEY, 3), 3));
});

test("valid positive integer → honoured", () => {
  withEnv("5", () => assertEquals(positiveIntEnv(KEY, 3), 5));
  withEnv("1", () => assertEquals(positiveIntEnv(KEY, 3), 1));
});

// Red/green regression for re-plan clearing `plan_reviews` (PR #26 review).
//
// `plan_reviews` is append-only and the review round is derived from `count(plan_reviews)`.
// When `startPlan` re-plans a previously finished issue it must clear the prior review rows,
// otherwise the stale count inflates the next round index and can reach the review-round cap
// early, bypassing the adversarial gate. This drives `startPlan` against an in-memory data layer and
// asserts the `plan_reviews` rows for the plan key are gone after a re-plan.
import { startPlan } from "./plan.ts";

// `startPlan` now fetches the epic issue title (issue #248) via the GitHub transport. Force the
// token transport with no token so the fetch is a hermetic no-op (returns null) and the row `title`
// deterministically coalesces to the `owner/repo#N` key — no `gh` subprocess, no network. A
// dedicated test below stubs a successful fetch to cover the real-title path. Capture the prior
// values and restore them after this file's tests so the module-scope mutation never leaks into
// other test files under concurrent `node --test`.
const PRIOR_TRANSPORT = process.env["NANO_PR_GITHUB_TRANSPORT"];
const PRIOR_TOKEN = process.env["GITHUB_TOKEN"];
process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
delete process.env["GITHUB_TOKEN"];
after(() => {
  if (PRIOR_TRANSPORT === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
  else process.env["NANO_PR_GITHUB_TRANSPORT"] = PRIOR_TRANSPORT;
  if (PRIOR_TOKEN === undefined) delete process.env["GITHUB_TOKEN"];
  else process.env["GITHUB_TOKEN"] = PRIOR_TOKEN;
});

function memTable(rows: any[], key: string) {
  return {
    get: (k: any) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
    find: (q: any) =>
      Promise.resolve(
        rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v)),
      ),
    insert: (r: any) => {
      rows.push(r);
      return Promise.resolve(r);
    },
    count: (q: any) =>
      Promise.resolve(
        rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v)).length,
      ),
    update: (k: any, patch: any) => {
      const r = rows.find((x) => x[key] === k);
      if (r) Object.assign(r, patch);
      return Promise.resolve(r);
    },
    delete: (k: any) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i][key] === k) rows.splice(i, 1);
      }
      return Promise.resolve();
    },
  };
}

test("re-plan of a finished issue clears stale plan_reviews rows", async () => {
  const PLAN_KEY = "owner/repo#7";
  const stores: Record<string, { rows: unknown[]; key: string }> = {
    plans: {
      rows: [{ plan_key: PLAN_KEY, status: "done", task_count: 2 }],
      key: "plan_key",
    },
    plan_tasks: {
      rows: [{ id: 1, plan_key: PLAN_KEY }, { id: 2, plan_key: PLAN_KEY }],
      key: "id",
    },
    plan_reviews: {
      rows: [
        { plan_key: PLAN_KEY, epoch: 0, round: 0 },
        { plan_key: PLAN_KEY, epoch: 0, round: 1 },
      ],
      key: "plan_key",
    },
    plan_task_deps: { rows: [], key: "plan_key" },
  };
  const data = {
    table: (name: string, key: string) =>
      memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
  } as any;
  const engine = {
    createInstance: () => Promise.resolve({ processInstanceKey: "PI-1" }),
  } as any;

  await startPlan(data, engine, {
    repo: "owner/repo",
    number: 7,
    url: "https://github.com/owner/repo/issues/7",
    planKey: PLAN_KEY,
  }, "epic/agent-protocol");

  assertEquals(stores.plan_reviews.rows.length, 0);
  assertEquals(stores.plan_tasks.rows.length, 0);
});

function memData(stores: Record<string, { rows: any[]; key: string }>) {
  return {
    table: (name: string, key: string) =>
      memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
  } as any;
}

// Coverage for the epic base-branch control (issue nano-ide #124 / 019_plan_base_branch.sql; ADR 0003).
//
// Every plan must pin a base branch so the fleet branches off — and opens every PR against — a
// long-lived integration branch instead of the repo default, keeping an epic off the default branch
// (and off any merge-to-default side effect such as auto-publishing) until the integration branch is
// deliberately merged. Since ADR 0003, base is REQUIRED: `normalizeBaseBranch` rejects a blank/absent
// value (`MissingBaseBranchError`) instead of falling back to the default. `renderBaseBranchBrief` is
// the authoritative prompt override, and `startPlan` persists the branch and seeds BOTH the
// `baseBranch` variable and the `baseBranchBrief` (which rides `appendPrompt`) unconditionally.
import { InvalidBaseBranchError, MissingBaseBranchError, normalizeBaseBranch, renderBaseBranchBrief } from "./plan.ts";

test("normalizeBaseBranch: blank/whitespace/undefined → MissingBaseBranchError; a real branch is trimmed", () => {
  assertThrows(() => normalizeBaseBranch(undefined), MissingBaseBranchError);
  assertThrows(() => normalizeBaseBranch(null), MissingBaseBranchError);
  assertThrows(() => normalizeBaseBranch(""), MissingBaseBranchError);
  assertThrows(() => normalizeBaseBranch("   "), MissingBaseBranchError);
  assertEquals(normalizeBaseBranch("  epic/agent-protocol  "), "epic/agent-protocol");
});

test("normalizeBaseBranch: accepts conservative git-branch shapes", () => {
  assertEquals(normalizeBaseBranch("main"), "main");
  assertEquals(normalizeBaseBranch("release-1.2"), "release-1.2");
  assertEquals(normalizeBaseBranch("feature/x_y.z"), "feature/x_y.z");
  // A plausible `epic/*` integration branch (the 019 convention) is returned unchanged.
  assertEquals(normalizeBaseBranch("epic/agent-protocol"), "epic/agent-protocol");
});

test("normalizeBaseBranch: rejects injection-prone / implausible branch names", () => {
  // `baseBranch` is interpolated into an authoritative agent prompt that carries shell
  // commands, so anything that isn't a plausible git ref must be rejected at the edge —
  // not silently rendered into `git`/`gh` snippets or the prompt Markdown.
  const bad = [
    "foo bar", // whitespace
    "-rf", // leading dash → looks like a CLI flag
    "foo; rm -rf /", // shell metacharacters
    "foo`whoami`", // command substitution
    "foo$(id)", // command substitution
    "foo\nbar", // newline → breaks rendered instructions
    "foo..bar", // git-illegal double dot
    "/foo", // leading slash
    "foo/", // trailing slash
    "foo.", // trailing dot
    "foo//bar", // empty path component
    "foo.lock", // git-reserved .lock suffix
    "épée", // outside the conservative allowlist
  ];
  for (const value of bad) {
    assertThrows(() => normalizeBaseBranch(value), InvalidBaseBranchError);
  }
});

test("renderBaseBranchBrief names the branch in every instruction (branch-off, read, PR base)", () => {
  const brief = renderBaseBranchBrief("epic/agent-protocol");
  // Authoritative marker so it overrides the static "default branch" wording.
  assertEquals(brief.includes("authoritative"), true);
  assertEquals(brief.includes("git checkout -b feat/<task.id> origin/epic/agent-protocol"), true);
  assertEquals(brief.includes("gh pr create --base epic/agent-protocol"), true);
});

test("startPlan pins the base branch: persisted on the row + seeded as baseBranch/baseBranchBrief variables", async () => {
  const PLAN_KEY = "owner/repo#124";
  const stores: Record<string, { rows: any[]; key: string }> = {
    plans: { rows: [], key: "plan_key" },
    plan_tasks: { rows: [], key: "id" },
    plan_reviews: { rows: [], key: "plan_key" },
    plan_escalations: { rows: [], key: "id" },
    plan_task_deps: { rows: [], key: "plan_key" },
  };
  const data = memData(stores);
  let seen: any = null;
  const engine = {
    createInstance: (req: any) => {
      seen = req.variables;
      return Promise.resolve({ processInstanceKey: "PI-1" });
    },
  } as any;

  await startPlan(
    data,
    engine,
    { repo: "owner/repo", number: 124, url: "https://github.com/owner/repo/issues/124", planKey: PLAN_KEY },
    "  epic/agent-protocol  ",
  );

  // Persisted (trimmed) on the plan row for the epic UI + resume.
  assertEquals((stores.plans.rows[0] as any).base_branch, "epic/agent-protocol");
  // Process variables the implement-task consumes.
  assertEquals(seen.baseBranch, "epic/agent-protocol");
  assertEquals(seen.baseBranchBrief.includes("gh pr create --base epic/agent-protocol"), true);
});

test("startPlan renders baseBranchBrief unconditionally now that base is required", async () => {
  const PLAN_KEY = "owner/repo#200";
  const stores: Record<string, { rows: any[]; key: string }> = {
    plans: { rows: [], key: "plan_key" },
    plan_tasks: { rows: [], key: "id" },
    plan_reviews: { rows: [], key: "plan_key" },
    plan_escalations: { rows: [], key: "id" },
    plan_task_deps: { rows: [], key: "plan_key" },
  };
  const data = memData(stores);
  let seen: any = null;
  const engine = {
    createInstance: (req: any) => {
      seen = req.variables;
      return Promise.resolve({ processInstanceKey: "PI-2" });
    },
  } as any;

  await startPlan(data, engine, {
    repo: "owner/repo",
    number: 200,
    url: "https://github.com/owner/repo/issues/200",
    planKey: PLAN_KEY,
  }, "epic/gate-branch");

  assertEquals((stores.plans.rows[0] as any).base_branch, "epic/gate-branch");
  assertEquals(seen.baseBranch, "epic/gate-branch");
  // The brief is always rendered — there is no null fork any more.
  assertEquals(seen.baseBranchBrief.includes("gh pr create --base epic/gate-branch"), true);
});

test("startPlan grandfathers a pre-existing null base_branch row: re-plan reads it without error", async () => {
  // Pre-ADR-0003 / in-flight rows carry base_branch = null (the column stays nullable). Re-planning
  // such a finished issue must read the old null row without error and re-pin it to the new explicit
  // base — the required-ness is enforced at admission of the new launch, not by a DB NOT NULL.
  const PLAN_KEY = "owner/repo#201";
  const stores: Record<string, { rows: any[]; key: string }> = {
    plans: { rows: [{ plan_key: PLAN_KEY, status: "done", task_count: 0, base_branch: null }], key: "plan_key" },
    plan_tasks: { rows: [], key: "id" },
    plan_reviews: { rows: [], key: "plan_key" },
    plan_escalations: { rows: [], key: "id" },
    plan_task_deps: { rows: [], key: "plan_key" },
  };
  const data = memData(stores);
  let seen: any = null;
  const engine = {
    createInstance: (req: any) => {
      seen = req.variables;
      return Promise.resolve({ processInstanceKey: "PI-3" });
    },
  } as any;

  await startPlan(data, engine, {
    repo: "owner/repo",
    number: 201,
    url: "https://github.com/owner/repo/issues/201",
    planKey: PLAN_KEY,
  }, "epic/gate-branch");

  // The grandfathered null row is re-pinned to the new explicit base without throwing.
  assertEquals((stores.plans.rows[0] as any).base_branch, "epic/gate-branch");
  assertEquals(seen.baseBranch, "epic/gate-branch");
});

// ── admitPlan decision matrix (ADR 0003 §Decision, rules 1-4) ────────────────
// The fail-fast admission gate composes four ORDERED rules before any fan-out. These drive it
// through a faked github transport (token mode + stubbed `globalThis.fetch`) and an in-memory
// `plans` table, asserting each rule's accept/reject and that the ORDER is load-bearing.
import { BaseBranchMustExistError } from "./github.ts";
import { admitPlan, DefaultBaseNotConfirmedError, findActivePlansByBase, SharedBaseError } from "./plan.ts";

interface AdmitRepo {
  repo: string;
  defaultBranch: string;
  branches: Set<string>;
  creates: string[]; // refs created via POST
  metaCalls: number; // GETs to /repos/:repo (default-branch resolution)
}

function admitFetch(state: AdmitRepo) {
  return (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = u.pathname;
    if (method === "GET" && path === `/repos/${state.repo}`) {
      state.metaCalls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ default_branch: state.defaultBranch }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    const refPrefix = `/repos/${state.repo}/git/ref/heads/`;
    if (method === "GET" && path.startsWith(refPrefix)) {
      const branch = decodeURIComponent(path.slice(refPrefix.length));
      if (!state.branches.has(branch)) return Promise.resolve(new Response("Not Found", { status: 404 }));
      return Promise.resolve(
        new Response(JSON.stringify({ ref: `refs/heads/${branch}`, object: { sha: `${branch}-sha` } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (method === "POST" && path === `/repos/${state.repo}/git/refs`) {
      // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
      const body = JSON.parse(String(init?.body ?? "{}")) as { ref?: string };
      const ref = String(body.ref ?? "");
      const branch = ref.replace(/^refs\/heads\//, "");
      if (state.branches.has(branch)) {
        return Promise.resolve(new Response(JSON.stringify({ message: "Reference already exists" }), { status: 422 }));
      }
      state.creates.push(ref);
      state.branches.add(branch);
      return Promise.resolve(new Response(JSON.stringify({ ref }), { status: 201 }));
    }
    return Promise.resolve(new Response(`unexpected ${method} ${path}`, { status: 500 }));
  };
}

async function withAdmit<T>(state: AdmitRepo, fn: () => Promise<T>): Promise<T> {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevFetch = globalThis.fetch;
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  globalThis.fetch = admitFetch(state) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prevFetch;
    if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
  }
}

function admitData(planRows: any[] = []) {
  return memData({ plans: { rows: planRows, key: "plan_key" } });
}

test("admitPlan rule 1: blank/absent base → MissingBaseBranchError (before any github call)", async () => {
  const state: AdmitRepo = { repo: "o/r1", defaultBranch: "main", branches: new Set(["main"]), creates: [], metaCalls: 0 };
  await withAdmit(state, async () => {
    await assertRejects(() => admitPlan(admitData(), state.repo, "", "tok"), MissingBaseBranchError);
    await assertRejects(() => admitPlan(admitData(), state.repo, null, "tok"), MissingBaseBranchError);
  });
  // Rule 1 fires before rule 2/3 — the default-branch endpoint is never hit.
  assertEquals(state.metaCalls, 0);
  assertEquals(state.creates.length, 0);
});

test("admitPlan rule 1: implausible base → InvalidBaseBranchError", async () => {
  const state: AdmitRepo = { repo: "o/r1b", defaultBranch: "main", branches: new Set(["main"]), creates: [], metaCalls: 0 };
  await withAdmit(state, async () => {
    await assertRejects(() => admitPlan(admitData(), state.repo, "bad branch;rm -rf", "tok"), InvalidBaseBranchError);
  });
  assertEquals(state.metaCalls, 0);
});

test("admitPlan rule 2: missing non-epic/* base → BaseBranchMustExistError (synchronous edge-400 path)", async () => {
  const state: AdmitRepo = { repo: "o/r2", defaultBranch: "main", branches: new Set(["main"]), creates: [], metaCalls: 0 };
  await withAdmit(state, async () => {
    await assertRejects(() => admitPlan(admitData(), state.repo, "release-9", "tok"), BaseBranchMustExistError);
  });
  assertEquals(state.creates.length, 0);
});

test("admitPlan rule 2: missing epic/* base → created off default HEAD, then admitted", async () => {
  const state: AdmitRepo = { repo: "o/r3", defaultBranch: "main", branches: new Set(["main"]), creates: [], metaCalls: 0 };
  const base = await withAdmit(state, () => admitPlan(admitData(), state.repo, "epic/new-thing", "tok"));
  assertEquals(base, "epic/new-thing");
  assertEquals(state.creates, ["refs/heads/epic/new-thing"]);
});

test("admitPlan rule 3: default-branch target WITHOUT confirmDefaultBase → DefaultBaseNotConfirmedError", async () => {
  const state: AdmitRepo = { repo: "o/r4", defaultBranch: "main", branches: new Set(["main"]), creates: [], metaCalls: 0 };
  await withAdmit(state, async () => {
    await assertRejects(() => admitPlan(admitData(), state.repo, "main", "tok"), DefaultBaseNotConfirmedError);
  });
});

test("admitPlan rule 3: default-branch target WITH confirmDefaultBase → admitted", async () => {
  const state: AdmitRepo = { repo: "o/r5", defaultBranch: "main", branches: new Set(["main"]), creates: [], metaCalls: 0 };
  const base = await withAdmit(state, () =>
    admitPlan(admitData(), state.repo, "main", "tok", { confirmDefaultBase: true }),
  );
  assertEquals(base, "main");
});

test("admitPlan rule 4: active shared CUSTOM base WITHOUT allowSharedBase → SharedBaseError", async () => {
  const state: AdmitRepo = { repo: "o/r6", defaultBranch: "main", branches: new Set(["main", "epic/shared"]), creates: [], metaCalls: 0 };
  const planRows = [{ plan_key: "o/r6#1", repo: "o/r6", base_branch: "epic/shared", status: "planning" }];
  await withAdmit(state, async () => {
    await assertRejects(() => admitPlan(admitData(planRows), state.repo, "epic/shared", "tok"), SharedBaseError);
  });
});

test("admitPlan rule 4: same-issue re-submit is admitted — selfPlanKey excludes the launch's OWN active row", async () => {
  // Idempotency regression: startPlan short-circuits an in-flight plan to `alreadyRunning`, but that
  // reachable only if admitPlan does NOT 409 the retry against the plan's own active row. With
  // selfPlanKey set, the shared-base guard excludes that row, so the same-issue re-submit is admitted.
  const state: AdmitRepo = { repo: "o/r6b", defaultBranch: "main", branches: new Set(["main", "epic/shared"]), creates: [], metaCalls: 0 };
  const planRows = [{ plan_key: "o/r6b#1", repo: "o/r6b", base_branch: "epic/shared", status: "planning" }];
  const base = await withAdmit(state, () =>
    admitPlan(admitData(planRows), state.repo, "epic/shared", "tok", { selfPlanKey: "o/r6b#1" }),
  );
  assertEquals(base, "epic/shared");
});

test("admitPlan rule 4: a DIFFERENT active plan on the same base still trips the guard even with selfPlanKey set", async () => {
  // selfPlanKey excludes only the launch's own row — a genuine collision with another epic still 409s.
  const state: AdmitRepo = { repo: "o/r6c", defaultBranch: "main", branches: new Set(["main", "epic/shared"]), creates: [], metaCalls: 0 };
  const planRows = [{ plan_key: "o/r6c#2", repo: "o/r6c", base_branch: "epic/shared", status: "planning" }];
  await withAdmit(state, async () => {
    await assertRejects(
      () => admitPlan(admitData(planRows), state.repo, "epic/shared", "tok", { selfPlanKey: "o/r6c#1" }),
      SharedBaseError,
    );
  });
});

test("admitPlan rule 4: same custom base WITH allowSharedBase → admitted", async () => {
  const state: AdmitRepo = { repo: "o/r7", defaultBranch: "main", branches: new Set(["main", "epic/shared"]), creates: [], metaCalls: 0 };
  const planRows = [{ plan_key: "o/r7#1", repo: "o/r7", base_branch: "epic/shared", status: "planning" }];
  const base = await withAdmit(state, () =>
    admitPlan(admitData(planRows), state.repo, "epic/shared", "tok", { allowSharedBase: true }),
  );
  assertEquals(base, "epic/shared");
});

test("admitPlan rule 4: two plans sharing the DEFAULT branch → always admitted (exempt)", async () => {
  const state: AdmitRepo = { repo: "o/r8", defaultBranch: "main", branches: new Set(["main"]), creates: [], metaCalls: 0 };
  // Another active plan already targets the default branch — the shared-base guard exempts it.
  const planRows = [{ plan_key: "o/r8#1", repo: "o/r8", base_branch: "main", status: "planning" }];
  const base = await withAdmit(state, () =>
    admitPlan(admitData(planRows), state.repo, "main", "tok", { confirmDefaultBase: true }),
  );
  assertEquals(base, "main");
});

test("admitPlan rule 4: a TERMINAL-status plan on the same base does NOT trip the guard", async () => {
  const state: AdmitRepo = { repo: "o/r9", defaultBranch: "main", branches: new Set(["main", "epic/done-base"]), creates: [], metaCalls: 0 };
  const planRows = [{ plan_key: "o/r9#1", repo: "o/r9", base_branch: "epic/done-base", status: "done" }];
  const base = await withAdmit(state, () => admitPlan(admitData(planRows), state.repo, "epic/done-base", "tok"));
  assertEquals(base, "epic/done-base");
});

test("admitPlan ORDER: a blank base is rejected before confirm-default / shared-base run", async () => {
  // Even with an active shared plan present AND the base being the default, rule 1 must fire first.
  const state: AdmitRepo = { repo: "o/r10", defaultBranch: "main", branches: new Set(["main"]), creates: [], metaCalls: 0 };
  const planRows = [{ plan_key: "o/r10#1", repo: "o/r10", base_branch: "main", status: "planning" }];
  await withAdmit(state, async () => {
    await assertRejects(() => admitPlan(admitData(planRows), state.repo, "  ", "tok"), MissingBaseBranchError);
  });
  assertEquals(state.metaCalls, 0); // never reached rule 3
});

test("admitPlan ORDER: a typo'd non-epic base is rejected (rule 2) before confirm-default (rule 3)", async () => {
  const state: AdmitRepo = { repo: "o/r11", defaultBranch: "main", branches: new Set(["main"]), creates: [], metaCalls: 0 };
  await withAdmit(state, async () => {
    await assertRejects(() => admitPlan(admitData(), state.repo, "mian", "tok"), BaseBranchMustExistError);
  });
  // ensureBaseBranch (rule 2) throws for the missing non-epic/* branch before fetchDefaultBranch (rule 3).
  assertEquals(state.metaCalls, 0);
});

test("findActivePlansByBase returns only non-terminal plans on the matching repo + base", async () => {
  const rows = [
    { plan_key: "o/x#1", repo: "o/x", base_branch: "epic/b", status: "planning" },
    { plan_key: "o/x#2", repo: "o/x", base_branch: "epic/b", status: "done" },
    { plan_key: "o/x#3", repo: "o/x", base_branch: "epic/other", status: "planning" },
  ];
  const active = await findActivePlansByBase(admitData(rows), "o/x", "epic/b");
  assertEquals(active.length, 1);
  assertEquals(active[0].plan_key, "o/x#1");
});

// Issue #248: the human-readable identity for the epics grids. `startPlan` persists a non-blank
// `plans.title` on BOTH the insert (new epic) and update (re-plan) paths — the fetched issue title
// when available, else the `owner/repo#N` key — so the title-led grid never renders a blank cell.
test("startPlan coalesces title to the key when the fetch yields nothing (insert path)", async () => {
  const PLAN_KEY = "owner/repo#248";
  const stores: Record<string, { rows: any[]; key: string }> = {
    plans: { rows: [], key: "plan_key" },
    plan_tasks: { rows: [], key: "id" },
    plan_reviews: { rows: [], key: "plan_key" },
    plan_task_deps: { rows: [], key: "plan_key" },
  };
  const engine = { createInstance: () => Promise.resolve({ processInstanceKey: "PI-T1" }) } as any;
  await startPlan(memData(stores), engine, {
    repo: "owner/repo",
    number: 248,
    url: "https://github.com/owner/repo/issues/248",
    planKey: PLAN_KEY,
  }, "main");
  assertEquals((stores.plans.rows[0] as any).title, PLAN_KEY);
});

test("startPlan repopulates a non-blank title on re-plan (update path)", async () => {
  const PLAN_KEY = "owner/repo#249";
  const stores: Record<string, { rows: any[]; key: string }> = {
    plans: { rows: [{ plan_key: PLAN_KEY, status: "done", task_count: 0, title: null }], key: "plan_key" },
    plan_tasks: { rows: [], key: "id" },
    plan_reviews: { rows: [], key: "plan_key" },
    plan_task_deps: { rows: [], key: "plan_key" },
  };
  const engine = { createInstance: () => Promise.resolve({ processInstanceKey: "PI-T2" }) } as any;
  await startPlan(memData(stores), engine, {
    repo: "owner/repo",
    number: 249,
    url: "https://github.com/owner/repo/issues/249",
    planKey: PLAN_KEY,
  }, "main");
  assertEquals((stores.plans.rows[0] as any).title, PLAN_KEY);
});

test("startPlan persists the real epic issue title when the fetch succeeds", async () => {
  const prevTok = process.env["GITHUB_TOKEN"];
  const prevFetch = globalThis.fetch;
  process.env["GITHUB_TOKEN"] = "t0ken";
  globalThis.fetch = ((url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/repos/owner/repo/issues/250")) {
      return Promise.resolve(new Response(JSON.stringify({ title: "Ship the epic" }), { status: 200 }));
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as typeof fetch;
  try {
    const stores: Record<string, { rows: any[]; key: string }> = {
      plans: { rows: [], key: "plan_key" },
      plan_tasks: { rows: [], key: "id" },
      plan_reviews: { rows: [], key: "plan_key" },
      plan_task_deps: { rows: [], key: "plan_key" },
    };
    const engine = { createInstance: () => Promise.resolve({ processInstanceKey: "PI-T3" }) } as any;
    await startPlan(memData(stores), engine, {
      repo: "owner/repo",
      number: 250,
      url: "https://github.com/owner/repo/issues/250",
      planKey: "owner/repo#250",
    }, "main");
    assertEquals((stores.plans.rows[0] as any).title, "Ship the epic");
  } finally {
    globalThis.fetch = prevFetch;
    if (prevTok === undefined) delete process.env["GITHUB_TOKEN"];
    else process.env["GITHUB_TOKEN"] = prevTok;
  }
});
