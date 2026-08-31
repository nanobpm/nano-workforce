// Structural guard for the implement cell's "clean terminal?" gateway (ic_gw) — the implement-stage
// escalation net (#358/#360), now owned by the shared `implement-cell` (ADR 0006 S4). Before the S4
// composition this gateway lived inline as `plan-fanout.bpmn`'s `w_gw` and `feature.bpmn`'s equivalent;
// composing the atomic cell relocated it (and its `record-escalation` recorder + `human-escalation`
// loop) into `implement-cell.bpmn`, which BOTH `feature.bpmn` and the `plan-fanout` MI body compose by
// `callActivity`. The invariant is unchanged: a slice with NO clean terminal status escalates to a
// human. The no-result case (the agent completes with `status` missing/undefined) is EXACTLY what must
// escalate, so the gateway must not depend on a `not(...)` negation that FEEL leaves `null` for a
// missing `status` (a null condition takes NO flow and would fall through to the default). We eliminate
// that failure mode categorically: ESCALATE is the DEFAULT flow and DONE is gated on the closed set of
// clean terminal statuses — so anything that is not a recognised clean terminal (including a
// missing/undefined status) escalates, regardless of how the engine evaluates equality against null.
//
// Pure text assertions over the committed BPMN (no engine), matching the repo's model-guard style.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assert, assertStringIncludes } from "#test-assert";

const bpmn = readFileSync("resources/processes/implement-cell.bpmn", "utf8");
const flat = bpmn.replace(/\s+/g, " ");

const gw = flat.match(/<bpmn:exclusiveGateway\b[^>]*\bid="ic_gw"[^>]*>/)?.[0] ?? "";
const icDone = flat.match(/<bpmn:sequenceFlow\b[^>]*\bid="ic_done"[^>]*\/>|<bpmn:sequenceFlow\b[^>]*\bid="ic_done"[\s\S]*?<\/bpmn:sequenceFlow>/)?.[0] ?? "";
const icEscalate = flat.match(/<bpmn:sequenceFlow\b[^>]*\bid="ic_escalate"[^>]*\/>|<bpmn:sequenceFlow\b[^>]*\bid="ic_escalate"[\s\S]*?<\/bpmn:sequenceFlow>/)?.[0] ?? "";

test("ic_gw: ESCALATE is the default flow, so a missing/undefined status can never fall through to done", () => {
  assert(gw, "ic_gw gateway must exist");
  assertStringIncludes(gw, 'default="ic_escalate"', "escalate must be the default — the no-result case escalates, never silently completes");
});

test("ic_gw: DONE is gated on the closed set of clean terminal statuses (not a fragile not(...) negation)", () => {
  assert(icDone, "ic_done flow must exist");
  assertStringIncludes(icDone, "conditionExpression", "the done flow must be conditional, not the default");
  assertStringIncludes(icDone, 'status = "opened"', "done requires a recognised clean terminal status");
  assertStringIncludes(icDone, 'status = "blocked"', "done requires a recognised clean terminal status");
  assertStringIncludes(icDone, 'status = "skipped"', "done requires a recognised clean terminal status");
});

test("ic_gw: the escalate flow carries no condition — it is the unconditional default sink", () => {
  assert(icEscalate, "ic_escalate flow must exist");
  assert(!icEscalate.includes("conditionExpression"), "escalate is the default flow and must carry no condition");
  assert(!icEscalate.includes("not("), "escalate must not depend on a not(...) negation that FEEL leaves null for a missing status");
});
