// Red/green regression for the plan-review round-cap parsing (PR #26 review).
//
// `MAX_PLAN_REVIEW_ROUNDS` bounds the adversarial revise loop. If the env override parsed to
// `NaN`/`0` (e.g. unset, "", "abc"), the cap check `round + 1 >= cap` would never fire and the
// planner could revise forever. `positiveIntEnv` must fall back to the default on any value that
// is not a positive integer, so the loop is always bounded.
import { test } from "node:test";
import { assertEquals, assertThrows } from "#test-assert";
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
  });

  assertEquals(stores.plan_reviews.rows.length, 0);
  assertEquals(stores.plan_tasks.rows.length, 0);
});

function memData(stores: Record<string, { rows: any[]; key: string }>) {
  return {
    table: (name: string, key: string) =>
      memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
  } as any;
}

// Coverage for the epic base-branch control (issue nano-ide #124 / 019_plan_base_branch.sql).
//
// A plan may pin a base branch so the fleet branches off — and opens every PR against — a long-lived
// integration branch instead of the repo default, keeping an epic off the default branch (and off any
// merge-to-default side effect such as auto-publishing) until the integration branch is deliberately
// merged. `normalizeBaseBranch` decides "unset" (fall back to default), `renderBaseBranchBrief` is the
// authoritative prompt override, and `startPlan` must persist the branch and seed BOTH the `baseBranch`
// variable and the `baseBranchBrief` (which rides `appendPrompt`) — or leave them null when unpinned.
import { InvalidBaseBranchError, normalizeBaseBranch, renderBaseBranchBrief } from "./plan.ts";

test("normalizeBaseBranch: blank/whitespace/undefined → null; a real branch is trimmed", () => {
  assertEquals(normalizeBaseBranch(undefined), null);
  assertEquals(normalizeBaseBranch(null), null);
  assertEquals(normalizeBaseBranch(""), null);
  assertEquals(normalizeBaseBranch("   "), null);
  assertEquals(normalizeBaseBranch("  epic/agent-protocol  "), "epic/agent-protocol");
});

test("normalizeBaseBranch: accepts conservative git-branch shapes", () => {
  assertEquals(normalizeBaseBranch("main"), "main");
  assertEquals(normalizeBaseBranch("release-1.2"), "release-1.2");
  assertEquals(normalizeBaseBranch("feature/x_y.z"), "feature/x_y.z");
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

test("startPlan without a base branch keeps default-branch behaviour (null row + null variables)", async () => {
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
  });

  assertEquals((stores.plans.rows[0] as any).base_branch, null);
  assertEquals(seen.baseBranch, null);
  assertEquals(seen.baseBranchBrief, null);
});
