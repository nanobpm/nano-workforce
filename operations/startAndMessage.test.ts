// Tests for the start/message operation delegates (ADR 0058 OpenAPI surface).
// These cover the app-logic guards the JSON schema can't express (reference parsing, message-name
// dispatch); the runtime's schema validation (required `pr`/`issue`/`name`) is exercised by urban's
// own api runtime tests.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import startConvergenceLoop from "./startConvergenceLoop.ts";
import startPlanFanout from "./startPlanFanout.ts";
import postMessage from "./postMessage.ts";

const app = {} as any as AppApi;

function input(body: any) {
  return {
    req: { method: "POST", path: "/", query: new URLSearchParams(), headers: new Headers(), text: async () => "" } as any,
    params: {},
    query: {},
    body,
  };
}

test("startConvergenceLoop → 400 on an unparseable PR reference", async () => {
  const res = await startConvergenceLoop(input({ pr: "not a pr" }), app);
  const r = res as any;
  assertEquals(r.status, 400);
  assertEquals(typeof r.body.error, "string");
});

test("startPlanFanout → 400 on an unparseable issue reference", async () => {
  const res = await startPlanFanout(input({ issue: "" }), app);
  const r = res as any;
  assertEquals(r.status, 400);
  assertEquals(typeof r.body.error, "string");
});

test("postMessage → 400 when name is blank", async () => {
  const res = await postMessage(input({ name: "" }), app);
  const r = res as any;
  assertEquals(r.status, 400);
  assertEquals(r.body.error, "name is required");
});

test("postMessage → 400 when escalation-answered lacks a correlationKey", async () => {
  const res = await postMessage(input({ name: "escalation-answered", variables: { answer: "yes" } }), app);
  const r = res as any;
  assertEquals(r.status, 400);
  assertEquals(r.body.error, "correlationKey is required");
});
