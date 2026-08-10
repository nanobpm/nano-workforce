// Red/green regression for the plan-review round-cap parsing (PR #26 review).
//
// `MAX_PLAN_REVIEW_ROUNDS` bounds the adversarial revise loop. If the env override parsed to
// `NaN`/`0` (e.g. unset, "", "abc"), the cap check `round + 1 >= cap` would never fire and the
// planner could revise forever. `positiveIntEnv` must fall back to the default on any value that
// is not a positive integer, so the loop is always bounded.
import { assertEquals } from "jsr:@std/assert@1";
import { positiveIntEnv } from "./plan.ts";
import { testBoundary } from "./test-support.ts";

const KEY = "NANO_PLAN_REVIEW_ROUNDS_TEST";
function withEnv(value: string | undefined, run: () => void) {
    const had = Object.hasOwn(Deno.env.toObject(), KEY);
    const prev = Deno.env.get(KEY);
    try {
        if (value === undefined)
            Deno.env.delete(KEY);
        else
            Deno.env.set(KEY, value);
        run();
    }
    finally {
        if (had && prev !== undefined)
            Deno.env.set(KEY, prev);
        else
            Deno.env.delete(KEY);
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

function memTable(rows: Record<string, unknown>[], key: string) {
    return {
        get: (k: unknown) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
        find: (q: Record<string, unknown>) => Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
        insert: (r: Record<string, unknown>) => {
            rows.push(r);
            return Promise.resolve(r);
        },
        update: (k: unknown, patch: Record<string, unknown>) => {
            const r = rows.find((x) => x[key] === k);
            if (r)
                Object.assign(r, patch);
            return Promise.resolve(r);
        },
        delete: (k: unknown) => {
            for (let i = rows.length - 1; i >= 0; i--) {
                if (rows[i][key] === k)
                    rows.splice(i, 1);
            }
            return Promise.resolve();
        },
    };
}
Deno.test("re-plan of a finished issue clears stale plan_reviews rows", async () => {
    const PLAN_KEY = "owner/repo#7";
    const stores: Record<string, {
        rows: unknown[];
        key: string;
    }> = {
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
    const data = testBoundary({
        table: (name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
    });
    const engine = testBoundary({
        createInstance: () => Promise.resolve({ processInstanceKey: "PI-1" }),
    });
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
    const stores: Record<string, {
        rows: unknown[];
        key: string;
    }> = {
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
    const data = testBoundary({
        table: (name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
    });
    const engine = testBoundary({
        createInstance: () => Promise.resolve({ processInstanceKey: "PI-1" }),
    });
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
    const plan = testBoundary<Record<string, unknown>>(stores.plans.rows[0]);
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

function escalationStores(rows: unknown[]): Record<string, {
    rows: unknown[];
    key: string;
}> {
    return {
        plans: { rows: [{ plan_key: "owner/repo#9" }], key: "plan_key" },
        plan_escalations: { rows, key: "id" },
        plan_tasks: { rows: [], key: "id" },
    };
}
function memData(stores: Record<string, {
    rows: Record<string, unknown>[];
    key: string;
}>) {
    return testBoundary({
        table: (name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
    });
}
Deno.test("refreshOpenTaskEscalation surfaces the OLDEST open escalation, then clears when none remain", async () => {
    const stores = escalationStores([
        { id: 2, plan_key: "owner/repo#9", task_id: "b", corr_key: "owner/repo#9:b", question: "Q-b", status: "open" },
        { id: 1, plan_key: "owner/repo#9", task_id: "a", corr_key: "owner/repo#9:a", question: "Q-a", status: "open" },
    ]);
    const data = memData(stores);
    await refreshOpenTaskEscalation(data, "owner/repo#9");
    let plan = testBoundary(stores.plans.rows[0]);
    assertEquals(plan.open_task_escalation_id, 1);
    assertEquals(plan.open_task_question, "Q-a");
    assertEquals(plan.open_task_corr_key, "owner/repo#9:a");
    assertEquals(plan.open_task_id, "a");
    // Once the oldest is answered, the next-oldest is surfaced.
    (testBoundary(stores.plan_escalations.rows.find((r: Record<string, unknown>) => r.id === 1))).status = "answered";
    await refreshOpenTaskEscalation(data, "owner/repo#9");
    plan = testBoundary(stores.plans.rows[0]);
    assertEquals(plan.open_task_escalation_id, 2);
    assertEquals(plan.open_task_id, "b");
    // With nothing open the denormalised fields clear.
    (testBoundary(stores.plan_escalations.rows.find((r: Record<string, unknown>) => r.id === 2))).status = "answered";
    await refreshOpenTaskEscalation(data, "owner/repo#9");
    plan = testBoundary(stores.plans.rows[0]);
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
    const published: unknown[] = [];
    const engine = testBoundary({
        publishMessage: (m: Record<string, unknown>) => {
            published.push(m);
            return Promise.resolve();
        },
    });
    const r = await answerTaskEscalation(data, engine, "owner/repo#9:a", "do it");
    assertEquals(r.ok, true);
    assertEquals(r.escalationId, 1);
    assertEquals(r.planKey, "owner/repo#9");
    assertEquals(r.taskId, "a");
    // Escalation row marked answered with the recorded answer.
    const esc = testBoundary(stores.plan_escalations.rows.find((x: Record<string, unknown>) => x.id === 1));
    assertEquals(esc.status, "answered");
    assertEquals(esc.answer, "do it");
    // Answer mirrored onto the task row.
    assertEquals((testBoundary(stores.plan_tasks.rows[0])).answer, "do it");
    // Correlated resume message published on the shared constant channel.
    assertEquals(published.length, 1);
    assertEquals(published[0].name, "feature-escalation-answered");
    assertEquals(published[0].correlationKey, "owner/repo#9:a");
    assertEquals(published[0].variables.answer, "do it");
    // Next-oldest open escalation re-surfaced on the plan row.
    assertEquals((testBoundary(stores.plans.rows[0])).open_task_escalation_id, 2);
});
Deno.test("answerTaskEscalation is a no-op when no open escalation matches the correlation key", async () => {
    const stores = escalationStores([]);
    const data = memData(stores);
    const engine = testBoundary({
        publishMessage: () => Promise.reject(new Error("should not publish")),
    });
    const r = await answerTaskEscalation(data, engine, "owner/repo#9:missing", "x");
    assertEquals(r.ok, false);
});
