// Unit coverage for the implement-stage escalation reason builder (issue #865). The defect: the
// implement-cell synthesised ONE generic "no machine-readable result (no status was reported)" reason
// for every non-clean-terminal outcome — a FALSE diagnosis when the agent reported `status: "completed"`
// with a summary but opened no PR. These tests pin the accurate, self-contained reason.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import {
  classifyImplementEscalation,
  implementEscalationQuestion,
  isClaimedCompletion,
  NO_RESULT_QUESTION,
  RECOGNIZED_IMPLEMENT_STATUSES,
} from "./implementEscalationReason.ts";

test("RECOGNIZED_IMPLEMENT_STATUSES is exactly the agent result vocabulary", () => {
  assertEquals([...RECOGNIZED_IMPLEMENT_STATUSES].sort(), ["blocked", "escalated", "opened", "skipped"]);
});

test("isClaimedCompletion: an off-vocabulary non-blank status is a claimed completion", () => {
  assertEquals(isClaimedCompletion("completed"), true);
  assertEquals(isClaimedCompletion("done"), true);
  assertEquals(isClaimedCompletion("opened"), false);
  assertEquals(isClaimedCompletion("escalated"), false);
  assertEquals(isClaimedCompletion(null), false);
  assertEquals(isClaimedCompletion("  "), false);
});

test("classifyImplementEscalation: blank/recognised → no-result; off-vocabulary → completed-without-delivery", () => {
  assertEquals(classifyImplementEscalation(null), "no-result");
  assertEquals(classifyImplementEscalation("escalated"), "no-result");
  assertEquals(classifyImplementEscalation("completed"), "completed-without-delivery");
});

test("NO_RESULT_QUESTION: the blank-status reason names a true no-result, not a completion", () => {
  assertEquals(NO_RESULT_QUESTION.includes("without a machine-readable result"), true);
  assertEquals(NO_RESULT_QUESTION.includes('reported status "'), false);
  // No summary/transcript folded in when none supplied.
  assertEquals(NO_RESULT_QUESTION.includes("summary"), false);
  assertEquals(NO_RESULT_QUESTION.includes("Transcript:"), false);
});

test("implementEscalationQuestion: a claimed completion names the exact status it reported", () => {
  const q = implementEscalationQuestion({ status: "completed" });
  assertEquals(q.includes('reported status "completed"'), true);
  assertEquals(q.includes("claimed completion without delivering"), true);
  // Distinct from the generic no-result lead.
  assertEquals(q.includes("without a machine-readable result"), false);
});

test("implementEscalationQuestion: folds in the agent's own summary and the transcript link (#863)", () => {
  const q = implementEscalationQuestion({
    status: "completed",
    summary: "implemented src/pin.rs and supporting changes",
    transcriptUrl: "http://merlin.local:3000/app/api/agentic/transcripts?stream=job%3A123",
  });
  assertEquals(q.includes('The agent\'s own summary: "implemented src/pin.rs and supporting changes".'), true);
  assertEquals(q.includes("Transcript: http://merlin.local:3000/app/api/agentic/transcripts?stream=job%3A123"), true);
  // The workspace-confinement hint (#865 ask 3) is present.
  assertEquals(q.includes("/tmp/<repo>"), true);
});

test("implementEscalationQuestion: a blank status with a summary surfaces the summary on the no-result lead", () => {
  const q = implementEscalationQuestion({ status: null, summary: "did some work" });
  assertEquals(q.includes("without a machine-readable result"), true);
  assertEquals(q.includes('The agent\'s own summary: "did some work".'), true);
});
