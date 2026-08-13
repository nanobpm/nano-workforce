// Unit coverage for the canonical escalation taxonomy (app/escalationTaxonomy.ts) — the single
// source of truth every raise site and escalation-conversion slice routes through (ADR 0002 §1).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import {
  classifyEscalation,
  type EscalationSignal,
  hasAnswerableQuestion,
  shouldRaiseTask,
} from "./escalationTaxonomy.ts";

test("hasAnswerableQuestion: only a non-blank string is answerable", () => {
  assertEquals(hasAnswerableQuestion("decide this"), true);
  assertEquals(hasAnswerableQuestion("  trimmed  "), true);
  for (const blank of [undefined, null, "", "   ", "\n\t"]) {
    assertEquals(hasAnswerableQuestion(blank), false, `blank ${JSON.stringify(blank)} is not answerable`);
  }
});

// --- review-round (roundResultDefault / gw-status) ---

test("review-round: an unknown/empty/converged status is transient (the empty-status backstop)", () => {
  for (const status of [undefined, "", "unknown", "converged", "addressed", "waiting"]) {
    assertEquals(
      classifyEscalation({ kind: "review-round", status, question: "ignored" }),
      "transient",
      `status ${JSON.stringify(status)} re-enters the loop`,
    );
  }
});

test("review-round: a human-blocking status WITH an answerable question is decision-required", () => {
  for (const status of ["needs_input", "blocked"]) {
    assertEquals(classifyEscalation({ kind: "review-round", status, question: "please decide" }), "decision-required");
  }
});

test("review-round: status is matched exactly (untrimmed), mirroring the gw-status conditions", () => {
  // The gw-status gateway does not trim `status`, so a whitespace-padded token is NOT the enum
  // value and stays transient. Pins the no-drift contract between this taxonomy and the model.
  for (const status of ["needs_input ", " needs_input", "blocked ", "converged "]) {
    assertEquals(
      classifyEscalation({ kind: "review-round", status, question: "please decide" }),
      "transient",
      `whitespace-padded status ${JSON.stringify(status)} is not the enum → transient`,
    );
  }
});

test("review-round: a human-blocking status with a BLANK question is a non-escalation", () => {
  for (const status of ["needs_input", "blocked"]) {
    for (const question of [undefined, "", "   "]) {
      assertEquals(
        classifyEscalation({ kind: "review-round", status, question }),
        "none",
        `blank-question ${status} cannot fabricate an escalation`,
      );
    }
  }
});

// --- dead-end-base (baseGuard) ---

test("dead-end-base: a confirmed dead end is decision-required; ambiguity is none", () => {
  assertEquals(classifyEscalation({ kind: "dead-end-base", deadEnd: true }), "decision-required");
  assertEquals(classifyEscalation({ kind: "dead-end-base", deadEnd: false }), "none");
  assertEquals(classifyEscalation({ kind: "dead-end-base" }), "none");
});

// --- merge-protocol (mergeProtocol) ---

test("merge-protocol: only a `ui` land method is decision-required; the rest are transient", () => {
  assertEquals(classifyEscalation({ kind: "merge-protocol", landMethod: "ui" }), "decision-required");
  for (const landMethod of ["gh-merge", "admin", "mergify-queue", undefined]) {
    assertEquals(
      classifyEscalation({ kind: "merge-protocol", landMethod }),
      "transient",
      `land method ${JSON.stringify(landMethod)} lands in-process`,
    );
  }
});

// --- task (plan-fanout w_gw "escalated?") ---

test("task: status=escalated with an answerable question is decision-required; blank is none", () => {
  assertEquals(classifyEscalation({ kind: "task", question: "which approach?" }), "decision-required");
  for (const question of [undefined, "", "   "]) {
    assertEquals(
      classifyEscalation({ kind: "task", question }),
      "none",
      "a blank-question escalated task is a non-escalation",
    );
  }
});

// --- the shared guard ---

test("shouldRaiseTask: true only for the decision-required tier", () => {
  const raised: EscalationSignal[] = [
    { kind: "review-round", status: "needs_input", question: "q" },
    { kind: "dead-end-base", deadEnd: true },
    { kind: "merge-protocol", landMethod: "ui" },
    { kind: "task", question: "q" },
  ];
  for (const s of raised) assert(shouldRaiseTask(s), `${s.kind} should raise a task`);

  const notRaised: EscalationSignal[] = [
    { kind: "review-round", status: "needs_input", question: "" }, // blank question
    { kind: "review-round", status: "waiting", question: "q" }, // transient
    { kind: "dead-end-base", deadEnd: false }, // ambiguous
    { kind: "merge-protocol", landMethod: "gh-merge" }, // transient
    { kind: "task", question: "   " }, // blank question
  ];
  for (const s of notRaised) assertEquals(shouldRaiseTask(s), false, `${s.kind} should NOT raise a task`);
});
