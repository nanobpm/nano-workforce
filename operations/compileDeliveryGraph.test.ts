// Tests for the POST /app/api/actions/compile-delivery-graph operation `compileDeliveryGraph`
// (ADR 0005 slice S1). The delegate is a thin, PURE mapping of the compiler's discriminated result
// onto the HTTP status: a well-formed graph → 200 { ok:true, … preview }, a malformed one → 400
// { ok:false, errors }. It touches no data layer and has zero side effects, so the same body compiled
// twice returns the identical response (callable repeatedly). These tests assert that status mapping.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";
import handler from "./compileDeliveryGraph.ts";

const app = { log: noopLog() } as unknown as AppApi;

async function call(body: unknown) {
  return (await handler({ req: {} as any, params: {}, query: {}, body } as any, app)) as any;
}

const GOOD = {
  name: "runbook",
  nodes: [
    { id: "a", kind: "agent", agent: { jobType: "senior:feature" } },
    { id: "b", kind: "human", human: { prompt: "do X" } },
  ],
  edges: [{ from: "a", to: "b" }],
};

test("compile-delivery-graph: a well-formed graph → 200 with the pure preview", async () => {
  const res = await call(GOOD);
  assertEquals(res.status, 200);
  assertEquals(res.body.ok, true);
  assert(typeof res.body.bpmn === "string" && res.body.bpmn.length > 0);
  // The compile preview must show what actually deploys — including the auto-laid-out diagram
  // interchange (#440), so the process explorer can render the previewed graph.
  assert(res.body.bpmn.includes("<bpmndi:BPMNDiagram"), "the previewed bpmn carries diagram interchange");
  assert(typeof res.body.diagram === "string" && res.body.diagram.length > 0);
  assertEquals(res.body.resolved.nodes.length, 2);
  assertEquals(res.body.humanNodes.length, 1);
});

test("compile-delivery-graph: a malformed graph → 400 with path-qualified errors", async () => {
  const res = await call({
    nodes: [{ id: "a", kind: "agent", agent: { jobType: "j" } }],
    edges: [{ from: "a", to: "ghost" }],
  });
  assertEquals(res.status, 400);
  assertEquals(res.body.ok, false);
  assert(Array.isArray(res.body.errors) && res.body.errors.length > 0);
  assert(res.body.errors.every((e: { path: string; message: string }) => typeof e.path === "string"));
});

test("compile-delivery-graph: is side-effect-free — repeated calls return identical responses", async () => {
  const a = await call(GOOD);
  const b = await call(GOOD);
  assertEquals(a.status, b.status);
  assertEquals(a.body.bpmn, b.body.bpmn);
  assertEquals(JSON.stringify(a.body.resolved), JSON.stringify(b.body.resolved));
});

test("compile-delivery-graph: a missing/empty body → 400, never a 500", async () => {
  const res = await call(undefined);
  assertEquals(res.status, 400);
  assertEquals(res.body.ok, false);
});
