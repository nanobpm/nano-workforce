// Tests for the start/message operation delegates (ADR 0058 OpenAPI surface).
// These cover the app-logic guards the JSON schema can't express (reference parsing, message-name
// dispatch); the runtime's schema validation (required `variables`/`name`) is exercised by urban's
// own api runtime tests.
import { assertEquals } from "jsr:@std/assert@1";
import type { AppApi } from "@nanobpm/urban";
import { fakeHttpRequest, testBoundary } from "../app/test-support.ts";
import postMessage from "./postMessage.ts";
import startConvergenceLoop from "./startConvergenceLoop.ts";
import startPlanFanout from "./startPlanFanout.ts";

const app = testBoundary<AppApi>(testBoundary({}));
function input(body: unknown) {
    return {
        req: fakeHttpRequest({ method: "POST", path: "/", query: new URLSearchParams(), headers: new Headers(), text: async () => "" }),
        params: {},
        query: {},
        body: testBoundary<Record<string, unknown>>(body),
    };
}
Deno.test("startConvergenceLoop → 400 on an unparseable PR reference", async () => {
    const res = await startConvergenceLoop(input({ variables: { pr: "not a pr" } }), app);
    const r = testBoundary(res);
    assertEquals(r.status, 400);
    assertEquals(typeof r.body.error, "string");
});
Deno.test("startPlanFanout → 400 on an unparseable issue reference", async () => {
    const res = await startPlanFanout(input({ variables: { issue: "" } }), app);
    const r = testBoundary(res);
    assertEquals(r.status, 400);
    assertEquals(typeof r.body.error, "string");
});
Deno.test("postMessage → 400 when name is blank", async () => {
    const res = await postMessage(input({ name: "" }), app);
    const r = testBoundary(res);
    assertEquals(r.status, 400);
    assertEquals(r.body.error, "name is required");
});
Deno.test("postMessage → 400 when escalation-answered lacks a correlationKey", async () => {
    const res = await postMessage(input({ name: "escalation-answered", variables: { answer: "yes" } }), app);
    const r = testBoundary(res);
    assertEquals(r.status, 400);
    assertEquals(r.body.error, "correlationKey is required");
});
