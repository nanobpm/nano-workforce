// Regression guard for issue #822 — the convergence loop must not REUSE a previous round's
// status/question/summary/escalated when an agent round returns NO result.
//
// The defect (proc 86936 / nano-coder#35): a `review-round` job taken by a misconfigured worker
// exited 0 in ~11s with NO result vars, no output, no commits, no push. Because nothing overwrote
// them, the PREVIOUS round's `status = "needs_input"`, `summary` and `question` stayed in scope.
// `gw-status` then routed on that stale `status`/`question` to `persist-escalation`, opening a
// word-for-word DUPLICATE of the escalation a human had just answered — the human's answer never
// reached an agent.
//
// The fix (categorical, not a special-case): clear the round's OUTPUT variables ON ENTRY to the
// round, on `capture-head` — the single task every entry into `review-round` routes through first
// (from Start, the review-loop re-enter, the human-answer resume, the husk auto-retry, and the
// ack-only retry). This mirrors the merge loop's `arm-merge`, which clears `status` on entry before
// its agent runs. With the round entering on a blank `status`/`question`, a no-result round can no
// longer inherit the prior round's decision: it falls through `gw-status`'s `f_addressed` default
// into `persist-round` → `check-progress`, where the unchanged PR head is caught as a no-progress
// (husk) round — retried within budget, then escalated as "produced nothing", NOT re-asked as an
// already-answered question.
//
// `answer`/`scopePending` (INPUTS the agent CONSUMES) are cleared on the review-round OUTPUT so the
// NEXT round can't re-consume them; `status`/`summary`/`question`/`escalated` (OUTPUTS the agent
// PRODUCES) must instead be cleared on ENTRY, because a same-task output-clear would clobber the
// agent's real verdict. Hence they live on `capture-head`, not on `review-round`.
//
// Pure text assertions over the committed BPMN (no engine), matching the repo's lightweight
// model-guard style (see convergenceEscalationGuard.test.ts, roundResultDefault.test.ts).

import { test } from "node:test";
import { assert, assertStringIncludes } from "#test-assert";
import { readFileSync } from "node:fs";

const bpmn = readFileSync("resources/processes/convergence-loop.bpmn", "utf8");
// Collapse whitespace so attribute-order / line-wrapping churn doesn't make the assertions brittle.
const flat = bpmn.replace(/\s+/g, " ");

/** The <serviceTask> element for the given id (whole element, up to its close), or null. */
function serviceTask(id: string): string | null {
  const m = flat.match(new RegExp(`<bpmn:serviceTask\\b[^>]*\\bid="${id}"[\\s\\S]*?</bpmn:serviceTask>`));
  return m ? m[0] : null;
}

// The round-output variables that must be reset on entry so a no-result round can't inherit them.
// `escalated` is reset to `false` (a boolean flag); the rest to `null` (absent).
const RESET_ON_ENTRY: ReadonlyArray<{ target: string; source: string }> = [
  { target: "status", source: "=null" },
  { target: "summary", source: "=null" },
  { target: "question", source: "=null" },
  { target: "escalated", source: "=false" },
];

test("capture-head clears the round's output vars on entry to every review round", () => {
  const el = serviceTask("capture-head");
  assert(el, "capture-head service task must exist");
  for (const { target, source } of RESET_ON_ENTRY) {
    const re = new RegExp(`<zeebe:output\\b[^>]*\\bsource="${source}"[^>]*\\btarget="${target}"[^>]*/>`);
    const alt = new RegExp(`<zeebe:output\\b[^>]*\\btarget="${target}"[^>]*\\bsource="${source}"[^>]*/>`);
    assert(
      re.test(el!) || alt.test(el!),
      `capture-head must clear "${target}" (source ${source}) on entry so a no-result round can't reuse the prior round's ${target} (issue #822)`,
    );
  }
});

test("capture-head still precedes review-round on every loop entry (the reset is truly on entry)", () => {
  // The reset is only "on entry to the round" if capture-head runs immediately before review-round
  // for EVERY way the loop re-enters. capture-head's single outgoing must target review-round, and
  // it must be the join for all the re-entry flows.
  const el = serviceTask("capture-head");
  assert(el, "capture-head service task must exist");
  const incoming = [...el!.matchAll(/<bpmn:incoming>([^<]+)<\/bpmn:incoming>/g)].map((m) => m[1]);
  for (const flow of ["f_start", "f_reviewLoop", "f_answerLoop", "f_huskRetry", "f_ackRetry"]) {
    assert(incoming.includes(flow), `capture-head must be the entry join for ${flow} so the reset covers that re-entry (issue #822)`);
  }
  const capture = flat.match(/<bpmn:sequenceFlow[^>]*\bid="f_capture"[^>]*\/>/);
  assert(capture, "f_capture flow missing");
  assertStringIncludes(capture![0], 'sourceRef="capture-head"');
  assertStringIncludes(capture![0], 'targetRef="review-round"');
});

test("gw-status still defaults a blank status to the addressed (re-enter) arm, not escalation", () => {
  // The reset only helps if a blank status routes to the no-progress/husk path rather than
  // escalation. This pins the interaction: with status/question cleared, gw-status falls to
  // f_addressed (persist-round → check-progress), where an unchanged head is caught as a husk.
  const gw = flat.match(/<bpmn:exclusiveGateway\b[^>]*\bid="gw-status"[^>]*>/);
  assert(gw, "gw-status gateway missing");
  assertStringIncludes(gw![0], 'default="f_addressed"');
});
