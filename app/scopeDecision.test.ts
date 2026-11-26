// Unit tests for the scope-decision provenance helpers (issue #1108).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { parseLinkedIssueNumbers } from "./operatorFeedback.ts";
import { agentScopeDecisionNote, answeredByFromActorKind, isOperatorDecision, postAgentScopeDecisionNote } from "./scopeDecision.ts";

test("answeredByFromActorKind maps the ledger identity, failing safe to unknown", () => {
  assertEquals(answeredByFromActorKind("human"), "operator");
  assertEquals(answeredByFromActorKind("agent"), "agent");
  assertEquals(answeredByFromActorKind(undefined), "unknown");
  assertEquals(answeredByFromActorKind("steward"), "unknown");
});

test("only an operator answer is an operator decision", () => {
  assertEquals(isOperatorDecision("operator"), true);
  assertEquals(isOperatorDecision("agent"), false);
  assertEquals(isOperatorDecision("unknown"), false);
  assertEquals(isOperatorDecision(null), false);
});

test("parseLinkedIssueNumbers finds closing and Part-of/Refs refs, not follow-ups", () => {
  assertEquals(parseLinkedIssueNumbers("Closes #1960\nFollow-up: #1983\nPart of #12, refs #7, Fixes: #3", "o/r"), [3, 7, 12, 1960]);
  assertEquals(parseLinkedIssueNumbers("", "o/r"), []);
});

test("the note names the agent decision and asks for Part of", () => {
  const note = agentScopeDecisionNote({ prUrl: "https://x/pull/1", answeredBy: "agent", answer: "MVP scope agreed" });
  assert(note.includes("Scope reduced by agent decision"));
  assert(note.includes("`Part of #N`"));
  assert(note.includes("> MVP scope agreed"));
});

test("postAgentScopeDecisionNote posts on the PR and each linked issue; failures are swallowed", async () => {
  const posted: number[] = [];
  const r = await postAgentScopeDecisionNote(
    { repo: "o/r", prNumber: 1984, prUrl: "u", answeredBy: "agent", answer: "a" },
    {
      prBody: async () => "Closes #1960\nFollow-up: #1983",
      comment: async (_repo, n) => {
        if (n === 1960) throw new Error("boom");
        posted.push(n);
      },
    },
  );
  assertEquals(posted, [1984]);
  assertEquals(r.failed, [1960]);
});
