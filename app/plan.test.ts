// biome-ignore-all lint/suspicious/noExplicitAny: existing tests use intentionally partial Urban test doubles.
// biome-ignore-all lint/plugin: existing tests use framework-boundary type assertions.
// biome-ignore-all lint/suspicious/noAssignInExpressions: tests use compact in-memory store helpers.
// biome-ignore-all lint/style/noNonNullAssertion: tests assert known fixture state.
// biome-ignore-all lint/complexity/useLiteralKeys: tests use string keys to mirror persisted field names.
// biome-ignore-all lint/correctness/noUnusedFunctionParameters: test doubles preserve framework callback shapes.
// biome-ignore-all lint/correctness/noUnusedVariables: tests keep named captures for readability.
// biome-ignore-all lint/complexity/useOptionalChain: tests keep explicit assertions for fixture state.
// biome-ignore-all assist/source/organizeImports: tests keep imports grouped by fixture role.
// Red/green regression for the plan-review round-cap parsing (PR #26 review).
//
// `MAX_PLAN_REVIEW_ROUNDS` bounds the adversarial revise loop. If the env override parsed to
// `NaN`/`0` (e.g. unset, "", "abc"), the cap check `round + 1 >= cap` would never fire and the
// planner could revise forever. `positiveIntEnv` must fall back to the default on any value that
// is not a positive integer, so the loop is always bounded.
import { assertEquals } from "jsr:@std/assert@1";
import { positiveIntEnv } from "./plan.ts";

const KEY = "NANO_PLAN_REVIEW_ROUNDS_TEST";

function withEnv(value: string | undefined, run: () => void) {
  const had = Object.hasOwn(Deno.env.toObject(), KEY);
  const prev = Deno.env.get(KEY);
  try {
    if (value === undefined) Deno.env.delete(KEY);
    else Deno.env.set(KEY, value);
    run();
  } finally {
    if (had && prev !== undefined) Deno.env.set(KEY, prev);
    else Deno.env.delete(KEY);
  }
}

Deno.test("unset → fallback (bounded loop, never NaN)", () => {
  withEnv(undefined, () => assertEquals(positiveIntEnv(KEY, 3), 3));
});

Deno.test("blank/whitespace → fallback, not 0", () => {
  withEnv("", () => assertEquals(positiveIntEnv(KEY, 3), 3));
  withEnv("   ", () => assertEquals(positiveIntEnv(KEY, 3), 3));
});

Deno.test("non-numeric → fallback, not NaN", () => {
  withEnv("abc", () => assertEquals(positiveIntEnv(KEY, 3), 3));
});

Deno.test("zero and negatives → fallback (cap must be >= 1)", () => {
  withEnv("0", () => assertEquals(positiveIntEnv(KEY, 3), 3));
  withEnv("-2", () => assertEquals(positiveIntEnv(KEY, 3), 3));
});

Deno.test("non-integer → fallback", () => {
  withEnv("2.5", () => assertEquals(positiveIntEnv(KEY, 3), 3));
});

Deno.test("valid positive integer → honoured", () => {
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

// deno-lint-ignore no-explicit-any
function memTable(rows: any[], key: string) {
  return {
    // deno-lint-ignore no-explicit-any
    get: (k: any) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
    // deno-lint-ignore no-explicit-any
    find: (q: any) =>
      Promise.resolve(
        rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v)),
      ),
    // deno-lint-ignore no-explicit-any
    insert: (r: any) => {
      rows.push(r);
      return Promise.resolve(r);
    },
    // deno-lint-ignore no-explicit-any
    update: (k: any, patch: any) => {
      const r = rows.find((x) => x[key] === k);
      if (r) Object.assign(r, patch);
      return Promise.resolve(r);
    },
    // deno-lint-ignore no-explicit-any
    delete: (k: any) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i][key] === k) rows.splice(i, 1);
      }
      return Promise.resolve();
    },
  };
}

Deno.test("re-plan of a finished issue clears stale plan_reviews rows", async () => {
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
        { plan_key: PLAN_KEY, round: 0 },
        { plan_key: PLAN_KEY, round: 1 },
      ],
      key: "plan_key",
    },
    plan_task_deps: { rows: [], key: "plan_key" },
  };
  const data = {
    table: (name: string, key: string) =>
      memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
    // deno-lint-ignore no-explicit-any
  } as any;
  const engine = {
    createInstance: () => Promise.resolve({ processInstanceKey: "PI-1" }),
    // deno-lint-ignore no-explicit-any
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

// Red/green regression for re-plan clearing stale open escalations (issue #25).
//
// `plan_escalations` is written by the implementation-phase escalation loop and denormalised onto
// the plan row (`open_task_*`). When `startPlan` re-plans a finished issue it deletes the prior
// `plan_tasks`, so any still-"open" escalation from that run points at a task that no longer
// exists. If those rows (and the plan's denormalised pointer) survive the re-plan,
// `refreshOpenTaskEscalation` re-surfaces a dead question in the answer form — the same
// stale-row class as `plan_reviews` above. This drives `startPlan` against the in-memory data
// layer and asserts both the escalation rows and the denormalised pointer are cleared.
Deno.test("re-plan of a finished issue clears stale open escalations and the denormalised open_task_* pointer", async () => {
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
    plan_escalations: {
      rows: [{
        id: 5,
        plan_key: PLAN_KEY,
        task_id: "task-1",
        corr_key: `${PLAN_KEY}:task-1`,
        question: "stale question from prior run?",
        status: "open",
      }],
      key: "id",
    },
    plan_task_deps: { rows: [], key: "plan_key" },
  };
  const data = {
    table: (name: string, key: string) =>
      memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
    // deno-lint-ignore no-explicit-any
  } as any;
  const engine = {
    createInstance: () => Promise.resolve({ processInstanceKey: "PI-1" }),
    // deno-lint-ignore no-explicit-any
  } as any;

  await startPlan(data, engine, {
    repo: "owner/repo",
    number: 8,
    url: "https://github.com/owner/repo/issues/8",
    planKey: PLAN_KEY,
  });

  // Stale escalation rows from the prior run must not survive a re-plan …
  assertEquals(stores.plan_escalations.rows.length, 0);
  // … and the plan's denormalised "surfaced escalation" pointer must be reset,
  // so `refreshOpenTaskEscalation` can't re-surface a question for a deleted task.
  const plan = stores.plans.rows[0] as Record<string, unknown>;
  assertEquals(plan.open_task_escalation_id, null);
  assertEquals(plan.open_task_question, null);
  assertEquals(plan.open_task_corr_key, null);
  assertEquals(plan.open_task_id, null);
});

// Red/green coverage for the implementation-phase escalation lifecycle (issue #25).
//
// `refreshOpenTaskEscalation` and `answerTaskEscalation` (issue #25) drive new stateful
// behaviour — denormalising the plan's "surfaced" escalation, mirroring the answer onto the
// task row, and publishing the correlated resume message — that had no unit coverage. These
// drive both against the in-memory data layer above and assert the oldest-first surfacing,
// the answer mirroring, and the published message.
import { answerTaskEscalation, refreshOpenTaskEscalation } from "./plan.ts";

function escalationStores(rows: unknown[]): Record<string, { rows: unknown[]; key: string }> {
  return {
    plans: { rows: [{ plan_key: "owner/repo#9" }], key: "plan_key" },
    plan_escalations: { rows, key: "id" },
    plan_tasks: { rows: [], key: "id" },
  };
}

// deno-lint-ignore no-explicit-any
function memData(stores: Record<string, { rows: any[]; key: string }>) {
  return {
    table: (name: string, key: string) =>
      memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
    // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("refreshOpenTaskEscalation surfaces the OLDEST open escalation, then clears when none remain", async () => {
  const stores = escalationStores([
    { id: 2, plan_key: "owner/repo#9", task_id: "b", corr_key: "owner/repo#9:b", question: "Q-b", status: "open" },
    { id: 1, plan_key: "owner/repo#9", task_id: "a", corr_key: "owner/repo#9:a", question: "Q-a", status: "open" },
  ]);
  const data = memData(stores);

  await refreshOpenTaskEscalation(data, "owner/repo#9");
  // deno-lint-ignore no-explicit-any
  let plan = stores.plans.rows[0] as any;
  assertEquals(plan.open_task_escalation_id, 1);
  assertEquals(plan.open_task_question, "Q-a");
  assertEquals(plan.open_task_corr_key, "owner/repo#9:a");
  assertEquals(plan.open_task_id, "a");

  // Once the oldest is answered, the next-oldest is surfaced.
  // deno-lint-ignore no-explicit-any
  (stores.plan_escalations.rows.find((r: any) => r.id === 1) as any).status = "answered";
  await refreshOpenTaskEscalation(data, "owner/repo#9");
  // deno-lint-ignore no-explicit-any
  plan = stores.plans.rows[0] as any;
  assertEquals(plan.open_task_escalation_id, 2);
  assertEquals(plan.open_task_id, "b");

  // With nothing open the denormalised fields clear.
  // deno-lint-ignore no-explicit-any
  (stores.plan_escalations.rows.find((r: any) => r.id === 2) as any).status = "answered";
  await refreshOpenTaskEscalation(data, "owner/repo#9");
  // deno-lint-ignore no-explicit-any
  plan = stores.plans.rows[0] as any;
  assertEquals(plan.open_task_escalation_id, null);
  assertEquals(plan.open_task_question, null);
  assertEquals(plan.open_task_corr_key, null);
  assertEquals(plan.open_task_id, null);
});

Deno.test("answerTaskEscalation records the answer, mirrors it onto the task, publishes the resume message, and re-surfaces the next escalation", async () => {
  const stores = escalationStores([
    { id: 1, plan_key: "owner/repo#9", task_id: "a", corr_key: "owner/repo#9:a", question: "Q-a", status: "open", answer: null },
    { id: 2, plan_key: "owner/repo#9", task_id: "b", corr_key: "owner/repo#9:b", question: "Q-b", status: "open", answer: null },
  ]);
  stores.plan_tasks.rows.push({ id: 10, plan_key: "owner/repo#9", task_id: "a", answer: null });
  const data = memData(stores);

  // deno-lint-ignore no-explicit-any
  const published: any[] = [];
  const engine = {
    // deno-lint-ignore no-explicit-any
    publishMessage: (m: any) => {
      published.push(m);
      return Promise.resolve();
    },
    // deno-lint-ignore no-explicit-any
  } as any;

  const r = await answerTaskEscalation(data, engine, "owner/repo#9:a", "do it");
  assertEquals(r.ok, true);
  assertEquals(r.escalationId, 1);
  assertEquals(r.planKey, "owner/repo#9");
  assertEquals(r.taskId, "a");

  // Escalation row marked answered with the recorded answer.
  // deno-lint-ignore no-explicit-any
  const esc = stores.plan_escalations.rows.find((x: any) => x.id === 1) as any;
  assertEquals(esc.status, "answered");
  assertEquals(esc.answer, "do it");

  // Answer mirrored onto the task row.
  // deno-lint-ignore no-explicit-any
  assertEquals((stores.plan_tasks.rows[0] as any).answer, "do it");

  // Correlated resume message published on the shared constant channel.
  assertEquals(published.length, 1);
  assertEquals(published[0].name, "feature-escalation-answered");
  assertEquals(published[0].correlationKey, "owner/repo#9:a");
  assertEquals(published[0].variables.answer, "do it");

  // Next-oldest open escalation re-surfaced on the plan row.
  // deno-lint-ignore no-explicit-any
  assertEquals((stores.plans.rows[0] as any).open_task_escalation_id, 2);
});

Deno.test("answerTaskEscalation is a no-op when no open escalation matches the correlation key", async () => {
  const stores = escalationStores([]);
  const data = memData(stores);
  const engine = {
    publishMessage: () => Promise.reject(new Error("should not publish")),
    // deno-lint-ignore no-explicit-any
  } as any;
  const r = await answerTaskEscalation(data, engine, "owner/repo#9:missing", "x");
  assertEquals(r.ok, false);
});
