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

// Red/green regression for re-plan resetting the denormalised open_task_* pointer (issue #25).
//
// When `startPlan` re-plans a finished issue it deletes the prior `plan_tasks`, so any stale
// "surfaced escalation" pointer denormalised onto the plan row (`open_task_*`) would otherwise
// point at a task that no longer exists — surfacing a dead question. The re-plan resets those
// pointers to null. (The escalation itself is now a native user task on the process instance, and a
// re-plan starts a fresh instance, so there is no separate escalation table to clear.)
test("re-plan of a finished issue resets the denormalised open_task_* pointer", async () => {
  const PLAN_KEY = "owner/repo#8";
  const stores: Record<string, { rows: unknown[]; key: string }> = {
    plans: {
      rows: [{
        plan_key: PLAN_KEY,
        status: "done",
        task_count: 1,
        open_task_escalation_id: 5,
        open_task_question: "stale question from prior run?",
        open_task_corr_key: `${PLAN_KEY}:task-1`,
        open_task_id: "task-1",
      }],
      key: "plan_key",
    },
    plan_tasks: { rows: [{ id: 1, plan_key: PLAN_KEY, task_id: "task-1" }], key: "id" },
    plan_reviews: { rows: [], key: "plan_key" },
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
    number: 8,
    url: "https://github.com/owner/repo/issues/8",
    planKey: PLAN_KEY,
  });

  // The plan's denormalised "surfaced escalation" pointer must be reset on a re-plan.
  const plan = stores.plans.rows[0] as Record<string, unknown>;
  assertEquals(plan.open_task_escalation_id, null);
  assertEquals(plan.open_task_question, null);
  assertEquals(plan.open_task_corr_key, null);
  assertEquals(plan.open_task_id, null);
});

// Red/green coverage for the implementation-phase + plan-review escalation answer paths (issue #25,
// epic #156). Both escalations are now native user tasks on the plan-fanout instance: answering an
// escalation locates the parked task via `searchUserTasks` (keyed by the plan's process instance)
// and completes it with the typed form variables that drive the downstream gateway.
import { answerPlanEscalation, answerTaskEscalation } from "./plan.ts";

function memData(stores: Record<string, { rows: any[]; key: string }>) {
  return {
    table: (name: string, key: string) =>
      memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
  } as any;
}

/** A fake engine whose `searchUserTasks` returns the seeded open tasks and whose `completeUserTask`
 *  records each completion for assertions. */
function fakeEngine(openTasks: any[]) {
  const completed: Array<{ userTaskKey: string; variables?: Record<string, unknown> }> = [];
  const engine = {
    searchUserTasks: (_filter?: Record<string, unknown>) => Promise.resolve(openTasks),
    completeUserTask: (userTaskKey: string, variables?: Record<string, unknown>) => {
      completed.push({ userTaskKey, variables });
      return Promise.resolve();
    },
  } as any;
  return { engine, completed };
}

test("answerTaskEscalation completes the parked feature-escalation task and mirrors the answer onto the task row", async () => {
  const stores = {
    plans: { rows: [{ plan_key: "owner/repo#9", process_key: "pk-9" }], key: "plan_key" },
    plan_tasks: { rows: [{ id: 10, plan_key: "owner/repo#9", task_id: "a", answer: null }], key: "id" },
  };
  const data = memData(stores);
  const { engine, completed } = fakeEngine([
    { userTaskKey: "ut-a", elementId: "feature-escalation", variables: { task: { id: "a" } } },
    { userTaskKey: "ut-b", elementId: "feature-escalation", variables: { task: { id: "b" } } },
  ]);

  const r = await answerTaskEscalation(data, engine, "owner/repo#9:a", "do it");
  assertEquals(r.ok, true);
  assertEquals(r.planKey, "owner/repo#9");
  assertEquals(r.taskId, "a");

  // The exact parked child (by task.id) is completed with the typed answer resolution.
  assertEquals(completed.length, 1);
  assertEquals(completed[0].userTaskKey, "ut-a");
  assertEquals(completed[0].variables, { resolution: "answer", answer: "do it" });

  // Answer mirrored onto the task row for the re-dispatched agent + UI.
  assertEquals((stores.plan_tasks.rows[0] as any).answer, "do it");
});

test("answerTaskEscalation is a no-op when no open escalation matches the correlation key", async () => {
  const stores = {
    plans: { rows: [{ plan_key: "owner/repo#9", process_key: "pk-9" }], key: "plan_key" },
    plan_tasks: { rows: [], key: "id" },
  };
  const { engine, completed } = fakeEngine([]);
  const r = await answerTaskEscalation(memData(stores), engine, "owner/repo#9:missing", "x");
  assertEquals(r.ok, false);
  assertEquals(completed.length, 0);
});

test("answerTaskEscalation rejects an empty taskId instead of completing an arbitrary escalation", async () => {
  const stores = {
    plans: { rows: [{ plan_key: "owner/repo#9", process_key: "pk-9" }], key: "plan_key" },
    plan_tasks: { rows: [{ id: 10, plan_key: "owner/repo#9", task_id: "a", answer: null }], key: "id" },
  };
  const { engine, completed } = fakeEngine([
    { userTaskKey: "ut-a", elementId: "feature-escalation", variables: { task: { id: "a" } } },
  ]);

  // Empty taskId suffix must NOT fall through to the single-candidate fallback and complete ut-a.
  const r = await answerTaskEscalation(memData(stores), engine, "owner/repo#9:", "do it");
  assertEquals(r.ok, false);
  assertEquals(completed.length, 0);
  assertEquals((stores.plan_tasks.rows[0] as any).answer, null);
});

test("answerPlanEscalation completes the parked plan-review-decision task with the typed directive + notes", async () => {
  const stores = {
    plans: { rows: [{ plan_key: "owner/repo#11", process_key: "pk-11" }], key: "plan_key" },
  };
  const { engine, completed } = fakeEngine([
    { userTaskKey: "ut-plan", elementId: "plan-review-decision", variables: {} },
  ]);

  const r = await answerPlanEscalation(
    memData(stores),
    engine,
    "owner/repo#11",
    "revise",
    "Use issue-1 as seam.",
  );
  assertEquals(r.ok, true);
  assertEquals(r.directive, "revise");
  assertEquals(completed.length, 1);
  assertEquals(completed[0].userTaskKey, "ut-plan");
  assertEquals(completed[0].variables, { directive: "revise", notes: "Use issue-1 as seam." });
});

test("answerPlanEscalation is a no-op when the plan has no parked decision task", async () => {
  const stores = {
    plans: { rows: [{ plan_key: "owner/repo#11", process_key: "pk-11" }], key: "plan_key" },
  };
  const { engine, completed } = fakeEngine([]);
  const r = await answerPlanEscalation(memData(stores), engine, "owner/repo#11", "proceed", "");
  assertEquals(r.ok, false);
  assertEquals(completed.length, 0);
});

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
