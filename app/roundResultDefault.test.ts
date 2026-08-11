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
//
// The body branch uses a tempered negative lookahead — `(?:(?!<bpmn:sequenceFlow\b).)*?`
// — so it can never over-match across a following `<bpmn:sequenceFlow>` element; it
// captures only up to *this* element's own close.
function flowElement(id: string): string | null {
  const re = new RegExp(
    `<bpmn:sequenceFlow\\b[^>]*?\\bid="${id}"[^>]*?(?:/>|>(?:(?!<bpmn:sequenceFlow\\b).)*?</bpmn:sequenceFlow>)`,
  );
  const m = flat.match(re);
  return m ? m[0] : null;
}

// Every `<bpmn:sequenceFlow>` element (whole element, self-closing or with children),
// using the same tempered-lookahead boundary as flowElement() so a captured element can
// never bleed into the next one.
function allFlows(): string[] {
  const re = new RegExp(
    "<bpmn:sequenceFlow\\b[^>]*?(?:/>|>(?:(?!<bpmn:sequenceFlow\\b).)*?</bpmn:sequenceFlow>)",
    "g",
  );
  return flat.match(re) ?? [];
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
  // Escalation is reachable ONLY via an explicit condition (the needs_input/blocked arm),
  // never as a catch-all default. Enumerate EVERY sequenceFlow into `persist-escalation`
  // and assert each one carries a conditionExpression — so no future edit can slip an
  // unconditional (default) arm into escalation.
  const intoEscalation = allFlows().filter((f) => /targetRef="persist-escalation"/.test(f));
  assert(intoEscalation.length > 0, "no flow targets persist-escalation");
  for (const f of intoEscalation) {
    assertStringIncludes(f, "conditionExpression");
  }
  // The addressed default must land on the guard (which re-solicits the review), not escalation.
  const addressed = flowElement("f_addressed");
  assert(addressed && /targetRef="gw-guard"/.test(addressed), "default arm must re-enter gw-guard");
});
