// Regression guard for the question-less convergence-loop escalation defect (issue #333).
//
// The convergence loop (`resources/processes/convergence-loop.bpmn`) has FIVE `persist-escalation`
// service tasks, but only ONE — `persist-escalation` (the `f_escalate` agent-verdict arm) — was
// routed through the `gw-escalated` gateway that honours the worker's `escalated` output. The other
// four flowed UNCONDITIONALLY into the durable `wait-answer` user task:
//
//   • persist-escalation-noprogress      (no progress made this round)
//   • persist-review-stalled             (review-wait timer fired)          ← wedged live
//   • persist-escalation-blockedcomments (unaddressed review comments)
//   • persist-escalation-maxrounds       (round cap reached)
//
// Per ADR 0002 §1 a blank question is a NON-escalation: `pr.persist-escalation` opens no row and
// returns `escalated:false`. The `persist-escalation-blockedcomments` arm maps its question from the
// OPTIONAL `convergeBlockReason` process variable, so a blank reason returned `escalated:false` yet
// STILL parked a dead `wait-answer` — a durable answer-wait with no escalation and a `null` question,
// surfaced on the merge-driving inbox with nothing for a human to answer (observed live on three
// instances, issue #333).
//
// The fix (mirroring the merge loop's `gw-merge-escalated`, PR #331): route EVERY arm that can reach
// `wait-answer` through the single `gw-escalated` guard, so a `persist-escalation` returning
// `escalated:false` RE-ENTERS the loop (`gw-guard`) instead of parking a dead wait. This makes the
// invariant structural — `wait-answer` is reachable ONLY from a `gw-escalated == true` edge, so a
// "durable answer-wait with no escalation" is unrepresentable.
//
// These are pure text assertions over the committed BPMN (no engine), matching the repo's
// lightweight model-guard style (see mergeEscalationQuestion.test.ts, mergeRebaseArm.test.ts).

import { test } from "node:test";
import { assert, assertStringIncludes } from "#test-assert";
import { readFileSync } from "node:fs";

const bpmn = readFileSync("resources/processes/convergence-loop.bpmn", "utf8");
// Collapse whitespace so attribute-order / line-wrapping churn doesn't make the assertions brittle.
const flat = bpmn.replace(/\s+/g, " ");

function flowHasId(id: string, source: string, target: string): boolean {
  const m = flat.match(new RegExp(`<bpmn:sequenceFlow\\b[^>]*\\bid="${id}"[^>]*(?:/>|>)`));
  if (!m) return false;
  const tag = m[0];
  return tag.includes(`sourceRef="${source}"`) && tag.includes(`targetRef="${target}"`);
}

function gatewayDefault(id: string, def: string): boolean {
  const m = flat.match(new RegExp(`<bpmn:exclusiveGateway\\b[^>]*\\bid="${id}"[^>]*>`));
  if (!m) return false;
  return m[0].includes(`default="${def}"`);
}

/** The <userTask> element for wait-answer, including its incoming flows. */
const waitAnswer = flat.match(/<bpmn:userTask\b[^>]*\bid="wait-answer"[\s\S]*?<\/bpmn:userTask>/);

// Every control-flow escalation arm and the gateway edge it must now route through.
const ARMS: ReadonlyArray<{ task: string; gate: string }> = [
  { task: "persist-escalation-noprogress", gate: "f_noprogressGate" },
  { task: "persist-review-stalled", gate: "f_stalledGate" },
  { task: "persist-escalation-blockedcomments", gate: "f_blockedGate" },
  { task: "persist-escalation-maxrounds", gate: "f_maxGate" },
];

test("every persist-escalation arm routes through gw-escalated, not straight to wait-answer", () => {
  for (const { task, gate } of ARMS) {
    assert(
      flowHasId(gate, task, "gw-escalated"),
      `${task} must route through gw-escalated (flow ${gate}), not directly to wait-answer (the #333 defect)`,
    );
  }
  // The agent-verdict arm already routed through the gate — keep it.
  assert(flowHasId("f_escGate", "persist-escalation", "gw-escalated"), "persist-escalation must route through gw-escalated");
});

test("gw-escalated honours persist-escalation's escalated output for every arm", () => {
  // escalated:true → park the native user task for a human to answer.
  assert(flowHasId("f_escWait", "gw-escalated", "wait-answer"), "gw-escalated → wait-answer (escalated) missing");
  const escWait = flat.match(/<bpmn:sequenceFlow[^>]*id="f_escWait"[\s\S]*?<\/bpmn:sequenceFlow>/);
  assert(escWait, "f_escWait flow missing");
  assertStringIncludes(escWait![0], "escalated = true", "the wait arm must be guarded by escalated = true");
  // escalated:false (a non-escalation, e.g. a blank convergeBlockReason) → re-enter the loop, not a dead wait.
  assert(gatewayDefault("gw-escalated", "f_escReenter"), "gw-escalated default must re-enter the loop");
  assert(flowHasId("f_escReenter", "gw-escalated", "gw-guard"), "the non-escalation arm must re-enter via gw-guard, not park a wait");
});

test("wait-answer is reachable ONLY from the gw-escalated == true edge (structural invariant)", () => {
  // The single most important guarantee of #333: a durable answer-wait with no escalation is
  // unrepresentable because the ONLY edge into wait-answer is the guarded f_escWait.
  assert(waitAnswer, "wait-answer user task must exist");
  const incoming = [...waitAnswer![0].matchAll(/<bpmn:incoming>([^<]+)<\/bpmn:incoming>/g)].map((m) => m[1]);
  assert(incoming.length === 1, `wait-answer must have exactly one incoming (the guarded f_escWait); found: ${incoming.join(", ")}`);
  assert(incoming[0] === "f_escWait", `wait-answer's only incoming must be f_escWait; found ${incoming[0]}`);
  // The retired dead-wait edges must be gone.
  for (const dead of ["f_noprogressWait", "f_stalledWait", "f_blockedWait", "f_maxWait"]) {
    assert(!flat.includes(`id="${dead}"`), `the dead-wait edge ${dead} must be removed`);
  }
});

test("each control-flow arm still carries a non-blank, human-actionable question", () => {
  // The guard closes the wedge, but a legitimate control-flow escalation must still open a real
  // escalation with a concrete question. Assert each arm supplies status + question via ioMapping.
  for (const { task } of ARMS) {
    const raw = flat.match(new RegExp(`<bpmn:serviceTask\\b[^>]*\\bid="${task}"[\\s\\S]*?</bpmn:serviceTask>`));
    assert(raw, `${task} service task must exist`);
    const el = raw![0];
    assertStringIncludes(el, 'target="status"', `${task} must set an explicit status`);
    assertStringIncludes(el, 'target="question"', `${task} must set a question`);
  }
});
