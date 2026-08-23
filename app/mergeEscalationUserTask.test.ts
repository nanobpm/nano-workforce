// Cross-layer drift guard: the merge-loop escalation user task the model parks on must be one the
// canonical completer (`agentCompletion.ts`) actually accepts and validates (#256, #466).
//
// The merge escalation converges on ONE native `wait-merge-answer` userTask (backed by the shared
// `pr-escalation` form) so it is answerable from the one Tasks inbox. The *behavioural* invariants —
// that the loop parks on that task, that answering it reconciles the escalations row and re-arms the
// poller — are exercised end-to-end by the WASM engine in `mergeLoopBehaviour.test.ts`. But that
// engine harness completes the task through the engine, NOT through nwf's application-level
// completer, so it cannot catch the specific silent-drift failure this guard closes: the model
// deploys and parks on `wait-merge-answer`, yet `agentCompletion.ts` refuses to drive it because the
// id fell out of `ESCALATION_TASK_ELEMENTS` (or its form contract drifted) — a task no worker will
// ever answer. This guard ties the model's user-task id to the completer's accepted set + form
// contract so the two layers cannot diverge unnoticed.

import { test } from "node:test";
import { assert } from "#test-assert";
import { readFileSync } from "node:fs";
import { ESCALATION_TASK_ELEMENTS, validateEscalationVariables } from "./agentCompletion.ts";

const flat = readFileSync("resources/processes/merge-loop.bpmn", "utf8").replace(/\s+/g, " ");

test("drift guard: the model's merge user-task element is one the canonical completer accepts", () => {
  // (1) The model actually parks on `wait-merge-answer` as a native user task...
  assert(
    /<bpmn:userTask\b[^>]*\bid="wait-merge-answer"/.test(flat),
    "the model must park the merge escalation on a userTask id='wait-merge-answer'",
  );
  // (2) ...and the completer accepts that exact id (else it deploys but is never answerable)...
  assert(
    ESCALATION_TASK_ELEMENTS.has("wait-merge-answer"),
    "ESCALATION_TASK_ELEMENTS must accept wait-merge-answer",
  );
  // (3) ...resolving to the pr-escalation form contract (a missing answer is rejected; a present
  // one accepted), proving the element maps to the same form the model renders.
  assert(
    validateEscalationVariables("wait-merge-answer", {}) !== null,
    "wait-merge-answer must enforce the pr-escalation form contract (answer required)",
  );
  assert(
    validateEscalationVariables("wait-merge-answer", { answer: "rebased and retried" }) === null,
    "a valid answer must satisfy the wait-merge-answer form contract",
  );
});
