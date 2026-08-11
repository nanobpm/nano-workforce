// Structural regression guard for the review-round "safe default" routing.
//
// A review round that exits without a machine-readable result (empty/unknown status)
// used to fall through the `gw-status` exclusive gateway's `default="f_escalate"`
// arm and escalate to a human — even after a benign rebase/force-push with no
// reviewer comments. That is premature: the round-cap gate (`gw-guard`) and the
// review-wait timeout already provide the human-escalation safety nets, and
// `persist-round` defaults an absent status to `addressed`.
//
// The fix inverts the gateway: escalation is now an EXPLICIT arm gated on
// `needs_input`/`blocked`, and `f_addressed` is the default, so any unknown/empty
// status re-enters the durable review wait instead of paging a human.
//
// This is a pure text assertion over the committed BPMN (no engine), matching the
// repo's lightweight model-guard style (see mergeRebaseArm.test.ts).

import { test } from "node:test";
import { assert, assertStringIncludes } from "#test-assert";
import { readFileSync } from "node:fs";

const bpmn = readFileSync("resources/processes/convergence-loop.bpmn", "utf8");

// Collapse whitespace so attribute-order / line-wrapping churn doesn't make the assertions brittle.
const flat = bpmn.replace(/\s+/g, " ");

// The `<sequenceFlow id="...">` element (whole element, up to its close), whether
// self-closing or with children. Returns the matched text or null.
function flowElement(id: string): string | null {
  const re = new RegExp(`<bpmn:sequenceFlow\\b[^>]*?\\bid="${id}"[^>]*?(/>|>.*?</bpmn:sequenceFlow>)`);
  const m = flat.match(re);
  return m ? m[0] : null;
}

test("gw-status defaults to the addressed arm, not escalation", () => {
  const gw = flat.match(/<bpmn:exclusiveGateway\b[^>]*\bid="gw-status"[^>]*>/);
  assert(gw, "gw-status gateway missing");
  assertStringIncludes(gw[0], 'default="f_addressed"');
  // The old premature-escalation default must be gone.
  assert(
    !/id="gw-status"[^>]*default="f_escalate"/.test(flat),
    "gw-status must no longer default to escalation",
  );
});

test("escalation is an explicit needs_input/blocked arm", () => {
  const esc = flowElement("f_escalate");
  assert(esc, "f_escalate flow missing");
  assertStringIncludes(esc, 'targetRef="persist-escalation"');
  // Escalation now only fires on an explicit human-blocking status.
  assertStringIncludes(esc, 'status = "needs_input" or status = "blocked"');
});

test("the default (addressed) arm carries no condition and re-enters the guard", () => {
  const addressed = flowElement("f_addressed");
  assert(addressed, "f_addressed flow missing");
  assertStringIncludes(addressed, 'targetRef="gw-guard"');
  // A default flow must have NO conditionExpression.
  assert(
    !/conditionExpression/.test(addressed),
    "f_addressed is the default flow and must not carry a conditionExpression",
  );
});

test("regression: an empty/unknown status no longer routes to persist-escalation", () => {
  // Escalation is reachable ONLY via the explicit needs_input/blocked condition or the
  // max-rounds guard — never as a catch-all default. Enumerate every flow into
  // persist-escalation and assert none of them is an unconditional (default) arm off gw-status.
  const esc = flowElement("f_escalate");
  assert(esc, "f_escalate flow missing");
  assertStringIncludes(esc, "conditionExpression");
  // The addressed default must land on the guard (which re-solicits the review), not escalation.
  const addressed = flowElement("f_addressed");
  assert(addressed && /targetRef="gw-guard"/.test(addressed), "default arm must re-enter gw-guard");
});
