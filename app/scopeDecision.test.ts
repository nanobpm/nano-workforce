// Unit tests for the scope-decision provenance helpers (issue #1108).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { isRunOwnComment, parseLinkedIssueNumbers } from "./operatorFeedback.ts";
import { agentScopeDecisionNote, answeredByFromActorKind, isOperatorDecision, isScopeEscalationQuestion, mayAutoReplayAdjudication, postAgentScopeDecisionNote, SCOPE_ESCALATION_PREFIX } from "./scopeDecision.ts";

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
  assert(note.includes("MVP scope agreed"));
});

test("#1109 assessment: the quoted answer is fenced inert — no escaping the fence, mentions stay in code", () => {
  const answer = "ok @someone\n```\n**bold** @other\n`````";
  const note = agentScopeDecisionNote({ prUrl: "u", answeredBy: "agent", answer });
  const fence = "``````";
  const i = note.indexOf(`${fence}text\n`);
  assert(i >= 0, "fence longer than the longest backtick run");
  assertEquals(note.slice(i), `${fence}text\n${answer}\n${fence}`);
  const outside = note.slice(0, i);
  assert(!outside.includes("@"), "no mention outside the code block");
});

test("#1109 assessment: linked issue targets are capped at 10 and limited to open issues", async () => {
  const refs = Array.from({ length: 50 }, (_, k) => `Refs #${k + 1}`).join("\n");
  const posted: number[] = [];
  const r = await postAgentScopeDecisionNote(
    { repo: "o/r", prNumber: 1000, prUrl: "u", answeredBy: "agent", answer: "a" },
    {
      prReferenceText: async () => refs,
      comment: async (_repo, n) => { posted.push(n); },
      isOpenIssue: async (_repo, n) => n % 2 === 0,
      hasNote: async () => false,
    },
  );
  assertEquals(posted.length, 11);
  assertEquals(posted[0], 1000);
  assert(posted.slice(1).every((n) => n % 2 === 0));
  assertEquals(r.failed, []);
});

test("postAgentScopeDecisionNote posts on the PR and each linked issue; failures are swallowed", async () => {
  const posted: number[] = [];
  const r = await postAgentScopeDecisionNote(
    { repo: "o/r", prNumber: 1984, prUrl: "u", answeredBy: "agent", answer: "a" },
    {
      prReferenceText: async () => "Closes #1960\nFollow-up: #1983",
      comment: async (_repo, n) => {
        if (n === 1960) throw new Error("boom");
        posted.push(n);
      },
      isOpenIssue: async () => true,
      hasNote: async () => false,
    },
  );
  assertEquals(posted, [1984]);
  assertEquals(r.failed, [1960]);
});

test("#1109: a scope escalation answered by a non-operator is never auto-replayed; others replay as before", () => {
  const q = `${SCOPE_ESCALATION_PREFIX}#1960 is only partly delivered`;
  assertEquals(isScopeEscalationQuestion(q), true);
  assertEquals(isScopeEscalationQuestion("retry cap?"), false);
  assertEquals(isScopeEscalationQuestion(null), false);
  assertEquals(mayAutoReplayAdjudication(q, "agent"), false);
  assertEquals(mayAutoReplayAdjudication(q, undefined), false);
  assertEquals(mayAutoReplayAdjudication(q, "human"), true);
  assertEquals(mayAutoReplayAdjudication("retry cap?", "agent"), true);
});

test("#1109 review: the app-owned scope note is the run's own comment, never operator feedback", () => {
  const note = agentScopeDecisionNote({ prUrl: "https://x/pull/1", answeredBy: "agent", answer: "MVP" });
  assertEquals(isRunOwnComment(note), true);
  assertEquals(isRunOwnComment(agentScopeDecisionNote({ prUrl: "u", answeredBy: "unknown", answer: undefined })), true);
});
