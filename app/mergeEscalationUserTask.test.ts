// Structural + cross-layer regression guard for converging the merge-loop escalation onto the ONE
// native user-task answer pathway (#256).
//
// Before #256 the merge loop parked on a durable `escalation-answered` message catch answered by a
// bespoke `answerEscalation()` publish — a SECOND answer pathway invisible to the Tasks inbox, so a
// merge escalation could not be answered from the nwf UI at all. It now parks on a native
// `wait-merge-answer` userTask (backed by `pr-escalation.form`) followed by the SAME
// `pr.answer-escalation` reconcile step the review loop's `wait-answer` runs, so both loops answer
// through the one canonical `completeUserTask` door and surface in the one Tasks inbox.
//
// These are pure text assertions over the committed BPMN (no engine), matching the repo's
// lightweight model-guard style (see mergeRebaseArm.test.ts), plus a drift guard tying the model's
// user-task element id to the completer's accepted escalation set so the two can't silently diverge.

import { test } from "node:test";
import { assert, assertStringIncludes } from "#test-assert";
import { readFileSync } from "node:fs";
import { ESCALATION_TASK_ELEMENTS, validateEscalationVariables } from "./agentCompletion.ts";

const bpmn = readFileSync("resources/processes/merge-loop.bpmn", "utf8");
const flat = bpmn.replace(/\s+/g, " ");

function hasFlow(source: string, target: string): boolean {
  const re = new RegExp(
    `<bpmn:sequenceFlow\\b[^>]*\\bsourceRef="${source}"[^>]*\\btargetRef="${target}"|` +
      `<bpmn:sequenceFlow\\b[^>]*\\btargetRef="${target}"[^>]*\\bsourceRef="${source}"`,
  );
  return re.test(flat);
}

test("the merge escalation parks on a native wait-merge-answer userTask backed by pr-escalation.form", () => {
  const task = flat.match(/<bpmn:userTask\b[^>]*\bid="wait-merge-answer"[\s\S]*?<\/bpmn:userTask>/);
  assert(task, "wait-merge-answer must be a <bpmn:userTask>");
  assertStringIncludes(task![0], 'formId="pr-escalation"', "it must render the shared pr-escalation form");
  assertStringIncludes(task![0], "<zeebe:userTask", "it must be a native (Zeebe) user task");
});

test("the answered task reconciles the escalations row, then re-arms the merge poller", () => {
  // wait-merge-answer → record-merge-answer (pr.answer-escalation) → arm-merge, mirroring the review
  // loop's wait-answer → record-answer. Without the reconcile step the escalations row would stay
  // `open` forever after the task completes (a phantom on /status).
  const record = flat.match(/<bpmn:serviceTask\b[^>]*\bid="record-merge-answer"[\s\S]*?<\/bpmn:serviceTask>/);
  assert(record, "record-merge-answer service task must exist");
  assertStringIncludes(record![0], 'type="pr.answer-escalation"', "it must run the shared reconcile worker");
  assert(hasFlow("wait-merge-answer", "record-merge-answer"), "wait-merge-answer → record-merge-answer missing");
  assert(hasFlow("record-merge-answer", "arm-merge"), "record-merge-answer → arm-merge (re-arm) missing");
});

test("the legacy escalation-answered message pathway is gone", () => {
  assert(!flat.includes("escalation-answered"), "the escalation-answered message must be removed");
  assert(!flat.includes("Message_mergeEscAnswered"), "the merge escalation message declaration must be removed");
  // The answer wait must no longer be a message catch — it is now a user task.
  assert(
    !/<bpmn:intermediateCatchEvent\b[^>]*\bid="wait-merge-answer"/.test(flat),
    "wait-merge-answer must no longer be an intermediateCatchEvent",
  );
});

test("drift guard: the model's merge user-task element is one the canonical completer accepts", () => {
  // The completer refuses any user task outside ESCALATION_TASK_ELEMENTS, so a model that parks on
  // `wait-merge-answer` while the code doesn't accept it would deploy but never be answerable — the
  // exact silent-drift failure mode this guard closes.
  assert(
    ESCALATION_TASK_ELEMENTS.has("wait-merge-answer"),
    "ESCALATION_TASK_ELEMENTS must accept wait-merge-answer",
  );
  // And it must map to the pr-escalation form contract (answer required) — a missing answer is
  // rejected, proving the element resolves to the same form the model renders.
  assert(
    validateEscalationVariables("wait-merge-answer", {}) !== null,
    "wait-merge-answer must enforce the pr-escalation form contract (answer required)",
  );
  assert(
    validateEscalationVariables("wait-merge-answer", { answer: "rebased and retried" }) === null,
    "a valid answer must satisfy the wait-merge-answer form contract",
  );
});
