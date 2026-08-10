import { assertEquals } from "jsr:@std/assert@1";
import { testBoundary } from "../../app/test-support.ts";
import handler from "./worker.ts";

function fakeApp() {
    const stores: Record<string, Record<string, unknown>[]> = { plan_retros: [] };
    const seq: Record<string, number> = {};
    function tbl(name: string, pk = "id") {
        const rows = stores[name] ?? [];
        stores[name] = rows;
        const match = (r: Record<string, unknown>, where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => r[k] === v);
        return {
            async insert(row: Record<string, unknown>) {
                const id = (seq[name] ?? 0) + 1;
                    seq[name] = id;
                rows.push(pk === "id" ? { id, ...row } : { ...row });
                return pk === "id" ? id : row[pk];
            },
            async find(where: Record<string, unknown> = {}) {
                return rows.filter((r) => match(r, where));
            },
            async findOne(where: Record<string, unknown> = {}) {
                return rows.find((r) => match(r, where));
            },
            async get(id: unknown) {
                return rows.find((row) => row[pk] === id);
            },
            async update(id: unknown, patch: Record<string, unknown>) {
                const r = rows.find((row) => row[pk] === id);
                if (r)
                    Object.assign(r, patch);
            },
        };
    }
    const app = { data: { table: (n: string, pk?: string) => tbl(n, pk) }, log: () => undefined };
    return { app, stores };
}
Deno.test("retro-record: persists a filed retro from hoisted result vars", async () => {
    const { app, stores } = fakeApp();
    await handler(testBoundary({
        variables: {
            planKey: "o/r#5",
            retroLearnings: 4,
            status: "filed",
            pr: "o/r#42",
            summary: "promoted 2 lessons",
            "io.nanobpm.agentResult": { output: "the full report" },
        },
    }), testBoundary(app));
    assertEquals(stores.plan_retros.length, 1);
    const row = stores.plan_retros[0];
    assertEquals(row.status, "filed");
    assertEquals(row.pr_key, "o/r#42");
    assertEquals(row.learnings, 4);
    assertEquals(row.summary, "promoted 2 lessons");
    assertEquals(row.report, "the full report");
});
Deno.test("retro-record: defaults to skipped when the agent filed no PR", async () => {
    const { app, stores } = fakeApp();
    await handler(testBoundary({ variables: { planKey: "o/r#6", summary: "nothing durable" } }), testBoundary(app));
    assertEquals(stores.plan_retros[0].status, "skipped");
    assertEquals(stores.plan_retros[0].pr_key, null);
});
Deno.test("retro-record: honours an explicit blocked status", async () => {
    const { app, stores } = fakeApp();
    await handler(testBoundary({ variables: { planKey: "o/r#7", status: "blocked", summary: "no write access" } }), testBoundary(app));
    assertEquals(stores.plan_retros[0].status, "blocked");
});
Deno.test("retro-record: ignores a PR unless the status is filed", async () => {
    const { app, stores } = fakeApp();
    await handler(testBoundary({ variables: { planKey: "o/r#8", status: "skipped", pr: "o/r#43", summary: "not durable" } }), testBoundary(app));
    assertEquals(stores.plan_retros[0].status, "skipped");
    assertEquals(stores.plan_retros[0].pr_key, null);
});
Deno.test("retro-record: defaults invalid status from PR presence", async () => {
    const { app, stores } = fakeApp();
    await handler(testBoundary({ variables: { planKey: "o/r#9", status: "done", pr: "o/r#44" } }), testBoundary(app));
    assertEquals(stores.plan_retros[0].status, "filed");
    assertEquals(stores.plan_retros[0].pr_key, "o/r#44");
});
Deno.test("retro-record: coerces filed without a PR to skipped", async () => {
    const { app, stores } = fakeApp();
    await handler(testBoundary({ variables: { planKey: "o/r#10", status: "filed", summary: "forgot the PR" } }), testBoundary(app));
    assertEquals(stores.plan_retros[0].status, "skipped");
    assertEquals(stores.plan_retros[0].pr_key, null);
});
