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
import { assert, assertEquals, assertStringIncludes } from "#test-assert";
import { readFileSync } from "node:fs";
import { routeRoundResult } from "./roundResultDefault.ts";

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

test("escalation is an explicit needs_input/blocked arm gated on a non-blank question", () => {
  const esc = flowElement("f_escalate");
  assert(esc, "f_escalate flow missing");
  assertStringIncludes(esc, 'targetRef="persist-escalation"');
  // Escalation now only fires on an explicit human-blocking status.
  assertStringIncludes(esc, 'status = "needs_input" or status = "blocked"');
  // ...AND only when the round carries an answerable question. A blank/absent/whitespace-only
  // question can no longer route to escalation (retires the blank-question fabrication failure
  // mode); it falls through to the addressed default and re-enters the review wait. The guard
  // trims so a whitespace-only question ("   ") is treated as blank too.
  assertStringIncludes(esc, 'question != null');
  assertStringIncludes(esc, 'trim(question) != ""');
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

// The canonical router (app/roundResultDefault.ts) mirrors the gw-status routing above, with the
// escalation decision delegated to the single taxonomy. These unit tests pin its behaviour — the
// same rules the structural BPMN assertions above enforce on the committed model.

test("routeRoundResult: a converged round converges", () => {
  assertEquals(routeRoundResult("converged", null), "converged");
  assertEquals(routeRoundResult("converged", "ignored"), "converged");
});

test("routeRoundResult: a human-blocking status with a question escalates", () => {
  assertEquals(routeRoundResult("needs_input", "please decide"), "escalate");
  assertEquals(routeRoundResult("blocked", "please decide"), "escalate");
});

test("routeRoundResult: a blank-question human-blocking status re-enters the loop (no fabrication)", () => {
  for (const status of ["needs_input", "blocked"]) {
    for (const question of [undefined, null, "", "   "]) {
      assertEquals(
        routeRoundResult(status, question),
        "reenter",
        `blank-question ${status} must re-enter the review wait, not escalate`,
      );
    }
  }
});

test("routeRoundResult: an addressed/unknown/empty status re-enters the loop", () => {
  for (const status of [undefined, "", "addressed", "waiting", "in_progress"]) {
    assertEquals(routeRoundResult(status, "q"), "reenter", `status ${JSON.stringify(status)} re-enters`);
  }
});

test("routeRoundResult: status is matched exactly, mirroring the untrimmed gw-status conditions", () => {
  // The gw-status gateway conditions do NOT trim `status` (unlike `question`, which trims for
  // blank-detection). `status` is a machine enum, so a whitespace-padded token is NOT the enum
  // value: it must route exactly as the deployed model does — never converge/escalate in code
  // while the model re-enters. This pins the no-drift contract.
  assertEquals(routeRoundResult("converged ", null), "reenter", "'converged ' is not the enum → re-enter");
  assertEquals(routeRoundResult(" converged", null), "reenter", "' converged' is not the enum → re-enter");
  assertEquals(routeRoundResult("needs_input ", "q"), "reenter", "'needs_input ' is not the enum → re-enter");
  assertEquals(routeRoundResult("blocked ", "q"), "reenter", "'blocked ' is not the enum → re-enter");
});

// --- Liveness guard: a non-escalation early return must not wedge on the durable answer-wait. ---
// `persist-escalation` may complete WITHOUT opening an escalation (worker returns
// `escalated:false` for a blank-question / non-decision-required job — defence-in-depth). The
// model must branch on that output so such a token re-enters the loop instead of flowing into
// `wait-answer`, which would block forever with no escalation for a human to answer.

test("persist-escalation routes through the gw-escalated liveness gateway, not straight to wait-answer", () => {
  // The only flow out of persist-escalation goes to the gateway.
  const escOut = allFlows().filter((f) => /sourceRef="persist-escalation"/.test(f));
  assertEquals(escOut.length, 1, "persist-escalation must have exactly one outgoing flow");
  assertStringIncludes(escOut[0], 'targetRef="gw-escalated"');
  // No flow leaves persist-escalation directly for wait-answer.
  assert(
    !escOut.some((f) => /targetRef="wait-answer"/.test(f)),
    "persist-escalation must not flow directly into wait-answer",
  );
});

test("gw-escalated waits only when an escalation was opened, else re-enters the guard", () => {
  const gw = flat.match(/<bpmn:exclusiveGateway\b[^>]*\bid="gw-escalated"[^>]*>/);
  assert(gw, "gw-escalated gateway missing");
  // Its default arm must be the re-enter (no-escalation) arm, never the answer-wait.
  assertStringIncludes(gw[0], 'default="f_escReenter"');

  // The wait arm is guarded on the worker's `escalated` output — a token only reaches the
  // durable answer-wait when an escalation actually exists.
  const wait = flowElement("f_escWait");
  assert(wait, "f_escWait flow missing");
  assertStringIncludes(wait, 'sourceRef="gw-escalated"');
  assertStringIncludes(wait, 'targetRef="wait-answer"');
  assertStringIncludes(wait, "escalated = true");

  // The default (no-escalation) arm carries no condition and re-enters gw-guard (forward
  // progress), so a non-escalation early return can never wedge on wait-answer.
  const reenter = flowElement("f_escReenter");
  assert(reenter, "f_escReenter flow missing");
  assertStringIncludes(reenter, 'sourceRef="gw-escalated"');
  assertStringIncludes(reenter, 'targetRef="gw-guard"');
  assert(
    !/conditionExpression/.test(reenter),
    "f_escReenter is the default arm and must not carry a conditionExpression",
  );
});

test("regression: every flow into wait-answer is either escalated-gated or a fixed-question escalation", () => {
  // wait-answer must never be reachable by an unconditional edge from the agent-raised
  // persist-escalation (whose escalation is conditional). The agent path reaches it only via
  // gw-escalated's `escalated = true` arm; the max-rounds / review-stalled paths set a fixed
  // non-blank question and so always escalate.
  const intoWait = allFlows().filter((f) => /targetRef="wait-answer"/.test(f));
  assert(intoWait.length > 0, "no flow targets wait-answer");
  for (const f of intoWait) {
    assert(
      !/sourceRef="persist-escalation"/.test(f),
      "wait-answer must not be entered directly from persist-escalation",
    );
  }
});
