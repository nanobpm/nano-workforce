import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import type { DataLayer } from "@nanobpm/urban";
import { appendEntry } from "../../app/blackboard.ts";
import { testBoundary } from "../../app/test-support.ts";
import handler from "./worker.ts";

function memData(): {
    data: DataLayer;
    stores: Record<string, Record<string, unknown>[]>;
} {
    const stores: Record<string, Record<string, unknown>[]> = {};
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
            async update() { },
        };
    }
    const data = testBoundary<DataLayer>(testBoundary({ table: (n: string, pk?: string) => tbl(n, pk) }));
    return { data, stores };
}
Deno.test("retro-gather: emits a digest brief + learning count for the plan", async () => {
    const { data, stores } = memData();
    stores.plans = [{ plan_key: "o/r#3", repo: "o/r", issue_url: "https://x/3", title: "Epic" }];
    await appendEntry(data, "o/r#3", { author_task: "t1", kind: "learning", body: "regen before build" });
    await appendEntry(data, "o/r#3", { author_task: "t2", kind: "learning", body: "use nextest" });
    const app = { data, log: () => undefined };
    const out = testBoundary<Record<string, unknown>>(await handler(testBoundary({ variables: { planKey: "o/r#3" } }), testBoundary(app)));
    assertEquals(out.retroLearnings, 2);
    assertStringIncludes(String(out.retroDigest), "regen before build");
    assertStringIncludes(String(out.retroDigest), "use nextest");
    assertStringIncludes(String(out.retroDigest), "o/r#3");
});
Deno.test("retro-gather: an epic with no learnings still renders a valid brief", async () => {
    const { data, stores } = memData();
    stores.plans = [{ plan_key: "o/r#4", repo: "o/r", issue_url: "", title: null }];
    const app = { data, log: () => undefined };
    const out = testBoundary<Record<string, unknown>>(await handler(testBoundary({ variables: { planKey: "o/r#4" } }), testBoundary(app)));
    assertEquals(out.retroLearnings, 0);
    assert(typeof out.retroDigest === "string");
    assertStringIncludes(String(out.retroDigest), "none");
});
