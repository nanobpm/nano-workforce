// Structural guard for the wave subprocess's "clean terminal?" gateway (w_gw) — the implement-stage
// escalation net (#358/#360). The whole point of the net is that a slice with NO clean terminal
// status escalates to a human. The no-result case (implement-task completes with `status`
// missing/undefined) is EXACTLY what must escalate, so the gateway must not depend on a `not(...)`
// negation that FEEL leaves `null` for a missing `status` (a null condition takes NO flow and would
// fall through to the default). We eliminate that failure mode categorically: ESCALATE is the
// DEFAULT flow and DONE is gated on the closed set of clean terminal statuses — so anything that is
// not a recognised clean terminal (including a missing/undefined status) escalates, regardless of
// how the engine evaluates equality against null.
//
// Pure text assertions over the committed BPMN (no engine), matching the repo's model-guard style.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assert, assertStringIncludes } from "#test-assert";

const bpmn = readFileSync("resources/processes/plan-fanout.bpmn", "utf8");
const flat = bpmn.replace(/\s+/g, " ");

const gw = flat.match(/<bpmn:exclusiveGateway\b[^>]*\bid="w_gw"[^>]*>/)?.[0] ?? "";
const wDone = flat.match(/<bpmn:sequenceFlow\b[^>]*\bid="w_done"[^>]*\/>|<bpmn:sequenceFlow\b[^>]*\bid="w_done"[\s\S]*?<\/bpmn:sequenceFlow>/)?.[0] ?? "";
const wEscalate = flat.match(/<bpmn:sequenceFlow\b[^>]*\bid="w_escalate"[^>]*\/>|<bpmn:sequenceFlow\b[^>]*\bid="w_escalate"[\s\S]*?<\/bpmn:sequenceFlow>/)?.[0] ?? "";

test("w_gw: ESCALATE is the default flow, so a missing/undefined status can never fall through to done", () => {
  assert(gw, "w_gw gateway must exist");
  assertStringIncludes(gw, 'default="w_escalate"', "escalate must be the default — the no-result case escalates, never silently completes");
});

test("w_gw: DONE is gated on the closed set of clean terminal statuses (not a fragile not(...) negation)", () => {
  assert(wDone, "w_done flow must exist");
  assertStringIncludes(wDone, "conditionExpression", "the done flow must be conditional, not the default");
  assertStringIncludes(wDone, 'status = "opened"', "done requires a recognised clean terminal status");
  assertStringIncludes(wDone, 'status = "blocked"', "done requires a recognised clean terminal status");
  assertStringIncludes(wDone, 'status = "skipped"', "done requires a recognised clean terminal status");
});

test("w_gw: the escalate flow carries no condition — it is the unconditional default sink", () => {
  assert(wEscalate, "w_escalate flow must exist");
  assert(!wEscalate.includes("conditionExpression"), "escalate is the default flow and must carry no condition");
  assert(!wEscalate.includes("not("), "escalate must not depend on a not(...) negation that FEEL leaves null for a missing status");
});
