// Model-drift guard for the `answerContext` boundary between the two answer loops (Copilot review of
// #806, suppressed advisories on convergence-loop.bpmn:312 and merge-loop.bpmn:332).
//
// `pr.answer-escalation` (the ONE worker servicing both `record-answer` in the convergence loop and
// `record-merge-answer` in the merge loop) feeds the durable convergence adjudication memory ONLY when
// `answerContext == "convergence"`. That classification rests entirely on a literal `<zeebe:input>`
// ioMapping on each service task. The worker-level tests inject `answerContext` DIRECTLY, so they would
// stay green even if a mapping were deleted or changed — a silent regression that would classify real
// convergence answers as legacy (disabling durable adjudication) or, with the wrong value, contaminate
// convergence adjudications with a merge decision.
//
// These pure text assertions over the committed BPMN pin the integration point the worker tests cannot
// see, matching the repo's lightweight model-guard style (convergenceEscalationGuard.test.ts,
// mergeEscalationUserTask.test.ts). The stored source encodes the FEEL string literal's quotes as the
// `&#34;` XML entity, so the expected sources below are the raw on-disk form.
import { test } from "node:test";
import { assert } from "#test-assert";
import { readFileSync } from "node:fs";

/** The `<bpmn:serviceTask id="…">…</bpmn:serviceTask>` block for `id`, whitespace-collapsed so
 *  attribute-order / line-wrapping churn does not make the assertions brittle. */
function serviceTask(file: string, id: string): string {
  const bpmn = readFileSync(`resources/processes/${file}`, "utf8").replace(/\s+/g, " ");
  const m = bpmn.match(new RegExp(`<bpmn:serviceTask\\b[^>]*\\bid="${id}"[\\s\\S]*?<\\/bpmn:serviceTask>`));
  assert(m, `${file} must define serviceTask ${id}`);
  return (m as RegExpMatchArray)[0];
}

const CASES: ReadonlyArray<{ file: string; task: string; context: string }> = [
  { file: "convergence-loop.bpmn", task: "record-answer", context: "convergence" },
  { file: "merge-loop.bpmn", task: "record-merge-answer", context: "merge" },
];

for (const { file, task, context } of CASES) {
  test(`${task} (${file}) is bound to pr.answer-escalation and stamps answerContext="${context}"`, () => {
    const block = serviceTask(file, task);
    assert(
      block.includes(`<zeebe:taskDefinition type="pr.answer-escalation"`),
      `${task} must invoke the pr.answer-escalation worker`,
    );
    // The exact literal ioMapping the worker's `isConvergence` test keys off. `&#34;` is the on-disk
    // encoding of the quotes around the FEEL string literal.
    assert(
      block.includes(`<zeebe:input source="=&#34;${context}&#34;" target="answerContext" />`),
      `${task} must stamp a literal answerContext="${context}" so the reconcile step classifies it correctly`,
    );
  });
}

// Cross-check the two contexts never collapse to the same value — a copy-paste that stamped
// "convergence" on the merge task (or vice versa) would let one loop's decision feed the other's memory.
test("the two answer loops stamp DISTINCT answerContext values", () => {
  const conv = serviceTask("convergence-loop.bpmn", "record-answer");
  const merge = serviceTask("merge-loop.bpmn", "record-merge-answer");
  assert(conv.includes(`&#34;convergence&#34;`), "convergence loop stamps convergence");
  assert(!conv.includes(`&#34;merge&#34;`), "convergence loop must NOT stamp merge");
  assert(merge.includes(`&#34;merge&#34;`), "merge loop stamps merge");
  assert(!merge.includes(`&#34;convergence&#34;`), "merge loop must NOT stamp convergence");
});

// Model-drift guard for the one-shot completion-identity handoff (Copilot review of #806).
// `completeUserTaskAttributed` stamps `completedUserTaskKey`/`completedCompletionId` onto the resumed
// convergence instance's variables, and record-answer reads them to pin adjudication attribution to the
// exact winning completion. But the convergence instance is REUSED across rounds, so if record-answer
// did not CLEAR them after consuming them, a later metadata-less (direct/legacy) completion would
// inherit the PREVIOUS round's `completedCompletionId` and `latestAdjudicator` would take the exact-id
// branch, attributing the new answer to the OLD completion instead of failing open. The `=null` outputs
// make the handoff one-shot; the worker tests inject these vars directly and so cannot see the clear.
test("record-answer CLEARS the one-shot completion-identity handoff vars after consuming them (#806 review)", () => {
  const block = serviceTask("convergence-loop.bpmn", "record-answer");
  assert(
    block.includes(`<zeebe:input source="=completedCompletionId" target="completedCompletionId" />`),
    "record-answer must READ completedCompletionId to pin exact-winner attribution",
  );
  assert(
    block.includes(`<zeebe:output source="=null" target="completedUserTaskKey" />`),
    "record-answer must CLEAR completedUserTaskKey so a later round cannot inherit a stale handoff",
  );
  assert(
    block.includes(`<zeebe:output source="=null" target="completedCompletionId" />`),
    "record-answer must CLEAR completedCompletionId so a later metadata-less completion fails open, not mis-attributes to the old completion",
  );
});
