// Issue #1037: a "Needs a closer look" verdict is a human-assessment request, not a fix finding.
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "#test-assert";
import {
  assessmentFixCompletionId,
  assessmentFixCompletionToken,
  assessmentHeadFromQuestion,
  assessmentQuestion,
  classifyAssessmentAnswer,
  isAssessmentAccepted,
  isAssessmentOnly,
  NEEDS_CLOSER_LOOK,
} from "./humanAssessment.ts";
import { reviewHeadToken, reviewWaitReason } from "./reviewWait.ts";

const HEAD = "68de21c0aaaabbbbccccddddeeeeffff00001111";
const c = (body: string, association = "MEMBER", login = "alice") => ({ id: 1, body, login, association, createdAt: "" });

test("isAssessmentOnly: only the closer-look verdict with a readable, fully-resolved thread set", () => {
  assertEquals(isAssessmentOnly([NEEDS_CLOSER_LOOK], []), true);
  assertEquals(isAssessmentOnly([NEEDS_CLOSER_LOOK], [{ isResolved: true }]), true);
  assertEquals(isAssessmentOnly([NEEDS_CLOSER_LOOK], [{ isResolved: false }]), false);
  assertEquals(isAssessmentOnly([NEEDS_CLOSER_LOOK], null), false);
  assertEquals(isAssessmentOnly([NEEDS_CLOSER_LOOK, "1 open issue"], []), false);
  assertEquals(isAssessmentOnly(["changes recommended"], []), false);
  assertEquals(isAssessmentOnly([], []), false);
});

test("isAssessmentAccepted: trusted, line-start marker for a prefix of this head", () => {
  assertEquals(isAssessmentAccepted([c("looks fine\nnano-assessment: accept 68de21c")], HEAD), true);
  assertEquals(isAssessmentAccepted([c(`nano-assessment: accept ${HEAD}`, "OWNER")], HEAD), true);
  assertEquals(isAssessmentAccepted([c("> nano-assessment: accept 68de21c")], HEAD), false);
  assertEquals(isAssessmentAccepted([c("ok nano-assessment: accept 68de21c")], HEAD), false);
  assertEquals(isAssessmentAccepted([c("nano-assessment: accept 68de21d")], HEAD), false);
  assertEquals(isAssessmentAccepted([c("nano-assessment: accept 68de21c", "CONTRIBUTOR")], HEAD), false);
  assertEquals(isAssessmentAccepted([c("nano-assessment: accept 68de21c", "MEMBER", "copilot[bot]")], HEAD), false);
  assertEquals(isAssessmentAccepted([c("nano-assessment: accept 68de21c")], ""), false);
});

test("classifyAssessmentAnswer: accept / fix / unrecognised", () => {
  assertEquals(classifyAssessmentAnswer("Accept"), "accept");
  assertEquals(classifyAssessmentAnswer("LGTM."), "accept");
  assertEquals(classifyAssessmentAnswer("lgtm, ship it"), null);
  assertEquals(classifyAssessmentAnswer("accept only after fixing the pool"), null);
  assertEquals(classifyAssessmentAnswer("merge is not safe; fix the pool first"), null);
  assertEquals(classifyAssessmentAnswer("approve? no"), null);
  assertEquals(classifyAssessmentAnswer("fix: bound the probe pool"), "fix");
  assertEquals(classifyAssessmentAnswer("retry"), null);
  assertEquals(classifyAssessmentAnswer(null), null);
});

test("assessmentQuestion quotes the verdict and names the head", () => {
  const q = assessmentQuestion({ repo: "o/r", prNumber: 5, head: HEAD, verdict: "🔵 Needs a closer look Risky." });
  assertStringIncludes(q, "Risky.");
  assertStringIncludes(q, "nano-assessment: accept 68de21c");
});

test("assessmentQuestion channel=comment offers ONLY the PR-comment marker (converge-gate never reads answer)", () => {
  const q = assessmentQuestion({ repo: "o/r", prNumber: 5, head: HEAD, verdict: "", channel: "comment" });
  assertStringIncludes(q, "nano-assessment: accept 68de21c");
  assertStringIncludes(q, "NOT read here");
  assertEquals(/reply "accept" to land/.test(q), false);
  // Default (merge) wording keeps the reply path it actually honours.
  assertStringIncludes(assessmentQuestion({ repo: "o/r", prNumber: 5, head: HEAD, verdict: "" }), 'reply "accept"');
});

test("/status names a human-assessment wait distinctly (not merging)", () => {
  const rows = [
    { id: 1, outcome: "review-pending", detail: `x ${reviewHeadToken("51c424c0")}` },
    { id: 2, outcome: "human-assessment", detail: `y ${reviewHeadToken(HEAD)}` },
  ];
  assertEquals(reviewWaitReason(rows), "waiting_human_assessment(68de21c)");
  assertEquals(reviewWaitReason([...rows, { id: 3, outcome: "assessment-accepted", detail: "" }]), null);
});

test("assessmentHeadFromQuestion reads the builder head, never a marker quoted from the verdict excerpt (#1037 review)", () => {
  const OLD = "1234567aaaa";
  for (const channel of ["answer", "comment"] as const) {
    const q = assessmentQuestion({ repo: "o/r", prNumber: 5, head: HEAD, verdict: `see \`nano-assessment: accept ${OLD}\``, channel });
    assertEquals(assessmentHeadFromQuestion(q), HEAD);
  }
  assertEquals(assessmentHeadFromQuestion(`x \`nano-assessment: accept ${OLD}\` Needs a closer look`), null);
  assertEquals(assessmentHeadFromQuestion(null), null);
});

test("assessmentHeadFromQuestion recognises the persisted converge-gate and merge-loop question forms (#1037 review)", () => {
  const q = assessmentQuestion({ repo: "o/r", prNumber: 5, head: HEAD, verdict: "", channel: "comment" });
  const gate = `Convergence blocked: the latest head-current Copilot review reports needs a closer look (a human assessment). ${q} Do NOT dispatch a fix round for this verdict.`;
  assertEquals(assessmentHeadFromQuestion(gate), HEAD);
  assertEquals(assessmentHeadFromQuestion(`This PR cannot be merged and needs a human decision. ${q}`), HEAD);
  // Any other lead-in is not builder-controlled, so it is never recognised.
  assertEquals(assessmentHeadFromQuestion(`Reviewer says: ${q}`), null);
});

test("assessmentFixCompletionToken round-trips through a detail string", () => {
  assertEquals(assessmentFixCompletionId(`re-entering ${assessmentFixCompletionToken(42)}`), 42);
  assertEquals(assessmentFixCompletionId("no token"), null);
});
