// Regression guard for the question-less merge escalation defect (issue #329).
//
// The merge loop (`resources/processes/merge-loop.bpmn`) raised escalations with NO question
// whenever a PR was blocked by anything other than a merge conflict: `merge-esc-attempt` called
// `pr.persist-escalation` with no `question`/`status` ioMapping, and its output flowed
// UNCONDITIONALLY into `wait-merge-answer`. Two coupled defects fell out of that:
//
//   1. A blank question surfaced on the merge-driving inbox — the human was asked to answer but
//      told nothing (observed live on nano-ide PR #354).
//   2. Per ADR 0002 §1 a blank question is a NON-escalation: `pr.persist-escalation` opens no row
//      and returns `escalated:false`. The convergence loop honours this via a `gw-escalated`
//      branch; the merge loop had none, so a question-less job still parked a dead
//      `wait-merge-answer` with nothing for a human to answer.
//
// The fix (mirroring the convergence loop): give `merge-esc-attempt` a human-actionable
// `status`/`question` that distinguishes its four trigger conditions, and add a `gw-merge-escalated`
// guard so a `persist-escalation` returning `escalated:false` re-enters the loop (re-arms the
// poller) instead of parking a dead wait.
//
// These are pure text assertions over the committed BPMN (no engine), matching the repo's
// lightweight model-guard style (see mergeRebaseArm.test.ts, mergeEscalationUserTask.test.ts).

import { test } from "node:test";
import { assert, assertStringIncludes } from "#test-assert";
import { readFileSync } from "node:fs";

const bpmn = readFileSync("resources/processes/merge-loop.bpmn", "utf8");
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

// The <serviceTask> element for merge-esc-attempt, including its ioMapping. Unescape XML entities so
// FEEL string literals (authored as `&#34;ready&#34;` inside the attribute) read naturally here.
const escAttemptRaw = flat.match(/<bpmn:serviceTask\b[^>]*\bid="merge-esc-attempt"[\s\S]*?<\/bpmn:serviceTask>/);
const escAttempt = escAttemptRaw
  ? [escAttemptRaw[0].replace(/&#34;/g, '"').replace(/&amp;/g, "&").replace(/&#10;/g, "\n")]
  : null;

test("merge-esc-attempt carries a non-blank, human-actionable status + question", () => {
  assert(escAttempt, "merge-esc-attempt service task must exist");
  const el = escAttempt![0];
  // Mirror the merge-esc-conflict mapping style: an explicit `blocked` status…
  assertStringIncludes(el, "<zeebe:ioMapping", "merge-esc-attempt must set an ioMapping (was absent — the #329 defect)");
  assertStringIncludes(el, 'target="status"', "merge-esc-attempt must set a `status`");
  assertStringIncludes(el, 'target="question"', "merge-esc-attempt must set a non-blank `question`");
  assertStringIncludes(el, '="blocked"', "the escalation status must be `blocked`");
});

test("the question distinguishes all four blocked/SLA triggers rather than a single generic string", () => {
  // Four flows route into merge-esc-attempt — the gate `blocked` default, CI could-not-fix,
  // rebase could-not-resolve, and the CI-fix SLA. Each is a legitimately different escalation and
  // the question must explain which one fired.
  const el = escAttempt![0];
  // gate blocked (gw-merge default): distinguishes on the `ready` mergeState + surfaces mergeStatus.
  assertStringIncludes(el, 'mergeState = "ready"', "must branch on the gate-blocked (ready) trigger");
  assertStringIncludes(el, "mergeStatus", "the gate-blocked question must surface the merge result");
  // rebase could-not-resolve (conflict arm).
  assertStringIncludes(el, 'mergeState = "conflict"', "must branch on the rebase (conflict) trigger");
  // CI could-not-fix vs CI SLA both arrive with mergeState = blocked — split on the agent `status`.
  assertStringIncludes(el, 'status = "blocked"', "must branch CI could-not-fix vs SLA on the agent status");
});

test("a gw-merge-escalated guard honours persist-escalation's escalated:false (mirrors the convergence loop)", () => {
  // The escalation output no longer flows UNCONDITIONALLY into the durable answer wait: it passes
  // through a gateway that reads the worker's `escalated` output.
  assert(
    flowHasId("f_m_escA", "merge-esc-attempt", "gw-merge-escalated"),
    "merge-esc-attempt must route through gw-merge-escalated, not straight to wait-merge-answer",
  );
  // escalated:true → park the native user task for a human to answer.
  assert(
    flowHasId("f_m_escWait", "gw-merge-escalated", "wait-merge-answer"),
    "gw-merge-escalated → wait-merge-answer (escalated) missing",
  );
  const escWait = flat.match(/<bpmn:sequenceFlow[^>]*id="f_m_escWait"[\s\S]*?<\/bpmn:sequenceFlow>/);
  assert(escWait, "f_m_escWait flow missing");
  assertStringIncludes(escWait![0], "escalated = true", "the wait arm must be guarded by escalated = true");
  // escalated:false (a non-escalation, e.g. a blank question) → re-enter the loop, NOT a dead wait.
  assert(
    gatewayDefault("gw-merge-escalated", "f_m_escReenter"),
    "gw-merge-escalated must default to f_m_escReenter (re-enter, not park)",
  );
  assert(
    flowHasId("f_m_escReenter", "gw-merge-escalated", "arm-merge"),
    "f_m_escReenter must re-arm the merge poller instead of parking a dead wait-merge-answer",
  );
});

test("regression: a question-less escalation can no longer park a dead wait-merge-answer", () => {
  // The exact #329 wedge: `merge-esc-attempt → wait-merge-answer` as a direct, unconditional edge.
  // It must be gone — the only path into the answer wait from the attempt arm is now guarded by
  // `escalated = true`.
  assert(
    !flowHasId("f_m_escA", "merge-esc-attempt", "wait-merge-answer"),
    "merge-esc-attempt must NOT flow directly into wait-merge-answer (the #329 dead-wait defect)",
  );
});
