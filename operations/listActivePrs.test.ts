// Tests for GET /app/api/status → operation `listActivePrs` (ADR 0058 OpenAPI surface).
// Covers the happy path (count/prs projection) and the optional shared-secret guard. A minimal
// in-memory DataLayer backs `activePrs` (it reads the `pull_requests` table via `.all()`).
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { AppApi } from "@nanobpm/urban";
import { fakeHttpRequest, testBoundary } from "../app/test-support.ts";
import handler from "./listActivePrs.ts";

function memApp(rows: Record<string, unknown>[]): AppApi {
    const tbl = {
        // deno-lint-ignore require-await
        async all() {
            return rows;
        },
    };
    return testBoundary<AppApi>(testBoundary({ data: { table: () => tbl } }));
}
function input(headers: Record<string, string> = {}) {
    return {
        req: fakeHttpRequest({
            method: "GET",
            path: "/app/api/status",
            query: new URLSearchParams(),
            headers: new Headers(headers),
            text: async () => "",
        }),
        params: {},
        query: {},
        body: undefined,
    };
}
Deno.test("returns 200 with a count + projected active PRs", async () => {
    const app = memApp([
        { pr_key: "o/r#1", repo: "o/r", number: 1, url: "u1", title: "t", status: "converging", current_round: 2, process_key: "9", updated_at: "2026-01-02" },
        { pr_key: "o/r#2", repo: "o/r", number: 2, url: "u2", title: null, status: "converged", current_round: 1, process_key: null, updated_at: "2026-01-01" },
    ]);
    const res = await handler(input(), app);
    const r = testBoundary(res);
    assertEquals(r.status, 200);
    // `converged` is terminal → filtered out, leaving one active PR.
    assertEquals(r.body.count, 1);
    assertEquals(r.body.prs.length, 1);
    assertEquals(r.body.prs[0].prKey, "o/r#1");
    assertEquals(r.body.prs[0].processKey, "9");
});
Deno.test("shared-secret guard rejects a missing secret when configured", async () => {
    const prev = Deno.env.get("NANO_PR_WEBHOOK_SECRET");
    Deno.env.set("NANO_PR_WEBHOOK_SECRET", "s3cr3t");
    try {
        const mod = await import(`./listActivePrs.ts?guard=${Date.now()}`);
        const guarded = testBoundary<typeof handler>(mod.default);
        const app = memApp([]);
        const bad = testBoundary((await guarded(input(), app)));
        assertEquals(bad.status, 401);
        const ok = testBoundary((await guarded(input({ "x-hook-secret": "s3cr3t" }), app)));
        assertEquals(ok.status, 200);
        assert("count" in ok.body);
    }
    finally {
        if (prev === undefined)
            Deno.env.delete("NANO_PR_WEBHOOK_SECRET");
        else
            Deno.env.set("NANO_PR_WEBHOOK_SECRET", prev);
    }
});
