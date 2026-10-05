// Unit coverage for the implement-stage escalation reason builder (issue #865). The defect: the
// implement-cell synthesised ONE generic "no machine-readable result (no status was reported)" reason
// for every non-clean-terminal outcome — a FALSE diagnosis when the agent reported `status: "completed"`
// with a summary but opened no PR. These tests pin the accurate, self-contained reason.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import {
  AFFIRMATIVE_COMPLETION_STATUSES,
  classifyImplementEscalation,
  implementEscalationQuestion,
  isClaimedCompletion,
  NO_RESULT_QUESTION,
  RECOGNIZED_IMPLEMENT_STATUSES,
} from "./implementEscalationReason.ts";

test("RECOGNIZED_IMPLEMENT_STATUSES is exactly the agent result vocabulary", () => {
  assertEquals([...RECOGNIZED_IMPLEMENT_STATUSES].sort(), ["blocked", "escalated", "opened", "skipped"]);
});

test("isClaimedCompletion: ONLY an affirmative-completion alias is a claimed completion (#865 review)", () => {
  // Affirmative-completion aliases → claimed completion.
  assertEquals(isClaimedCompletion("completed"), true);
  assertEquals(isClaimedCompletion("done"), true);
  assertEquals(isClaimedCompletion("success"), true);
  // Case-insensitive — an agent shouting `DONE`/`Completed` still claims completion.
  assertEquals(isClaimedCompletion("Completed"), true);
  assertEquals(isClaimedCompletion("DONE"), true);
  // Non-affirmative off-vocabulary (failure / input-required / unknown) is NOT a completion claim:
  // it must escalate accurately, never be adopted as success or retried with a false diagnosis.
  assertEquals(isClaimedCompletion("failed"), false);
  assertEquals(isClaimedCompletion("needs_input"), false);
  assertEquals(isClaimedCompletion("error"), false);
  assertEquals(isClaimedCompletion("wibble"), false);
  // Recognised statuses and blanks are never claimed completions.
  assertEquals(isClaimedCompletion("opened"), false);
  assertEquals(isClaimedCompletion("escalated"), false);
  assertEquals(isClaimedCompletion(null), false);
  assertEquals(isClaimedCompletion("  "), false);
  // The alias set is non-empty and stable.
  assertEquals(AFFIRMATIVE_COMPLETION_STATUSES.has("completed"), true);
});

test("classifyImplementEscalation: blank → no-result; affirmative → completed-without-delivery; else → reported-status", () => {
  assertEquals(classifyImplementEscalation(null), "no-result");
  assertEquals(classifyImplementEscalation("  "), "no-result");
  assertEquals(classifyImplementEscalation("completed"), "completed-without-delivery");
  assertEquals(classifyImplementEscalation("done"), "completed-without-delivery");
  // A reported `escalated` with no answerable question is NOT a no-result — it is a reported status
  // (#865 review: the false "no status was reported" diagnosis is retired).
  assertEquals(classifyImplementEscalation("escalated"), "reported-status");
  // A non-affirmative off-vocabulary failure/input-required is a reported status, never a completion.
  assertEquals(classifyImplementEscalation("failed"), "reported-status");
  assertEquals(classifyImplementEscalation("needs_input"), "reported-status");
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

test("implementEscalationQuestion: a reported non-completion status names it accurately, never 'no status' or 'claimed completion' (#865 review)", () => {
  // A reported `escalated` whose question was blank reaches the builder — it must NOT claim "no status
  // was reported", and must NOT claim completion.
  const esc = implementEscalationQuestion({ status: "escalated" });
  assertEquals(esc.includes('reported status "escalated"'), true);
  assertEquals(esc.includes("gave no answerable question"), true);
  assertEquals(esc.includes("without a machine-readable result"), false);
  assertEquals(esc.includes("claimed completion"), false);
  // A non-affirmative off-vocabulary failure is reported accurately, not adopted as a completion claim.
  const failed = implementEscalationQuestion({ status: "failed" });
  assertEquals(failed.includes('reported status "failed"'), true);
  assertEquals(failed.includes("claimed completion"), false);
});

test("implementEscalationQuestion: an agent's answerable question leads and PRESERVES its summary + transcript context (#865 review)", () => {
  // The #865-review defect: an `escalated` result carrying a question + summary + transcript persisted
  // ONLY the question, losing the supporting decision context pollUserTasks surfaces.
  const q = implementEscalationQuestion({
    status: "escalated",
    question: "Should I target the epic base or main?",
    summary: "drafted the migration but the base is ambiguous",
    transcriptUrl: "http://merlin.local:3000/t?stream=job%3A777",
  });
  // The agent's own question leads.
  assertEquals(q.startsWith("Should I target the epic base or main?"), true);
  // Its summary and transcript are preserved as context.
  assertEquals(q.includes('The agent\'s own summary: "drafted the migration but the base is ambiguous".'), true);
  assertEquals(q.includes("Transcript: http://merlin.local:3000/t?stream=job%3A777"), true);
  // No synthesised lead / recovery tail when the agent raised its own genuine escalation.
  assertEquals(q.includes("without a machine-readable result"), false);
  assertEquals(q.includes("/tmp/<repo>"), false);
});

test("implementEscalationQuestion: a blank/whitespace question does NOT lead — it synthesises accurately", () => {
  const q = implementEscalationQuestion({ status: "completed", question: "   " });
  assertEquals(q.includes('reported status "completed"'), true);
  assertEquals(q.includes("/tmp/<repo>"), true); // recovery tail present on the synthesised path
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
