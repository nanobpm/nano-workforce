// Tests for the POST /app/api/actions/delivery-graph/preview operation `previewDeliveryGraph`
// (issue #386, ADR 0005 slice S1) — the human-facing UI JSON-paste PREVIEW ingress. It parses the
// operator's pasted JSON STRING and runs the SAME pure `compileDeliveryGraph` compiler the agent door
// uses, mapping the result onto a compact summary (200) or a human `error` + path-qualified `errors`
// (400). It is PURE — no data layer, no dispatch — so it mirrors the compile door's test harness.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";
import handler from "./previewDeliveryGraph.ts";

const app = { log: noopLog() } as unknown as AppApi;

async function call(body: unknown) {
  return (await handler({ req: {} as any, params: {}, query: {}, body } as any, app)) as any;
}

const GOOD = JSON.stringify({
  name: "runbook",
  nodes: [
    { id: "a", kind: "agent", agent: { jobType: "senior:feature" } },
    { id: "b", kind: "human", human: { prompt: "do X" } },
  ],
  edges: [{ from: "a", to: "b" }],
});

test("preview-delivery-graph: a pasted well-formed graph → 200 summary with digest + counts", async () => {
  const res = await call({ graphJson: GOOD });
  assertEquals(res.status, 200);
  assertEquals(res.body.ok, true);
  assert(typeof res.body.digest === "string" && res.body.digest.length > 0);
  assertEquals(res.body.nodeCount, 2);
  assertEquals(res.body.humanNodeCount, 1);
  assertEquals(res.body.sideEffectCount, 1);
  assertEquals(res.body.sideEffecting, true);
  assert(typeof res.body.diagram === "string" && res.body.diagram.length > 0);
  assertEquals(res.body.title, "runbook");
  // The FULL preview detail (#441) — the human stop-points and side-effecting actions the page
  // renders, not just the counts. `a` is the side-effecting agent node; `b` is the human stop.
  assert(Array.isArray(res.body.humanNodes) && res.body.humanNodes.length === 1);
  assertEquals(res.body.humanNodes[0].nodeId, "b");
  assertEquals(res.body.humanNodes[0].prompt, "do X");
  assert(Array.isArray(res.body.sideEffects) && res.body.sideEffects.length === 1);
  assertEquals(res.body.sideEffects[0].nodeId, "a");
  assertEquals(res.body.sideEffects[0].kind, "agent");
  assert(typeof res.body.sideEffects[0].description === "string" && res.body.sideEffects[0].description.length > 0);
});

test("preview-delivery-graph: is PURE — repeated previews return the identical digest", async () => {
  const a = await call({ graphJson: GOOD });
  const b = await call({ graphJson: GOOD });
  assertEquals(a.body.digest, b.body.digest);
});

test("preview-delivery-graph: text that is not valid JSON → 400 with a human error", async () => {
  const res = await call({ graphJson: "{ not json" });
  assertEquals(res.status, 400);
  assertEquals(res.body.ok, false);
  assert(typeof res.body.error === "string" && res.body.error.includes("not valid JSON"));
});

test("preview-delivery-graph: a blank paste → 400, never a 500", async () => {
  const res = await call({ graphJson: "   " });
  assertEquals(res.status, 400);
  assertEquals(res.body.ok, false);
  assert(typeof res.body.error === "string" && res.body.error.length > 0);
});

test("preview-delivery-graph: a valid-JSON but malformed graph → 400 with path-qualified errors", async () => {
  const res = await call({
    graphJson: JSON.stringify({ nodes: [{ id: "a", kind: "agent", agent: { jobType: "j" } }], edges: [{ from: "a", to: "ghost" }] }),
  });
  assertEquals(res.status, 400);
  assertEquals(res.body.ok, false);
  assert(Array.isArray(res.body.errors) && res.body.errors.length > 0);
  assert(res.body.errors.every((e: { path: string; message: string }) => typeof e.path === "string"));
});

test("preview-delivery-graph: a pasted JSON array (not an object) → 400", async () => {
  const res = await call({ graphJson: "[]" });
  assertEquals(res.status, 400);
  assertEquals(res.body.ok, false);
});
