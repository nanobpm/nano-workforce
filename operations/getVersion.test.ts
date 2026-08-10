// Tests for GET /app/api/version → operation `getVersion` (ADR 0058 OpenAPI surface).
// Ported from the previous actions/version.test.ts. Method handling now belongs to the router
// (only GET is routed here), so there is no 405 case to test at the delegate level.
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { AppApi } from "@nanobpm/urban";
import { fakeHttpRequest, testBoundary } from "../app/test-support.ts";
import handler from "./getVersion.ts";

const app = testBoundary<AppApi>(testBoundary({}));
function input(headers: Record<string, string> = {}) {
    return {
        req: fakeHttpRequest({
            method: "GET",
            path: "/app/api/version",
            query: new URLSearchParams(),
            headers: new Headers(headers),
            text: async () => "",
        }),
        params: {},
        query: {},
        body: undefined,
    };
}
Deno.test("returns 200 with the app identity", async () => {
    const res = await handler(input(), app);
    const r = testBoundary(res);
    assertEquals(r.status, 200);
    assertEquals(r.body.name, "nano-workforce");
    // These are always present; their values are environment-dependent so we only assert shape.
    assert("version" in r.body);
    assert("urbanVersion" in r.body);
    assert("gitSha" in r.body);
    assert("gitBranch" in r.body);
    assert(typeof r.body.runtime === "string" && r.body.runtime.length > 0);
    assert(typeof r.body.startedAt === "string");
    assert(typeof r.body.uptimeSeconds === "number");
});
Deno.test("shared-secret guard rejects a missing/wrong secret when configured", async () => {
    const prev = Deno.env.get("NANO_PR_WEBHOOK_SECRET");
    Deno.env.set("NANO_PR_WEBHOOK_SECRET", "s3cr3t");
    try {
        // SECRET is bound at import time, so import a cache-busted copy to observe the guard.
        const mod = await import(`./getVersion.ts?guard=${Date.now()}`);
        const guarded = testBoundary<typeof handler>(mod.default);
        const bad = testBoundary((await guarded(input(), app)));
        assertEquals(bad.status, 401);
        const ok = testBoundary((await guarded(input({ "x-hook-secret": "s3cr3t" }), app)));
        assertEquals(ok.status, 200);
    }
    finally {
        if (prev === undefined)
            Deno.env.delete("NANO_PR_WEBHOOK_SECRET");
        else
            Deno.env.set("NANO_PR_WEBHOOK_SECRET", prev);
    }
});
