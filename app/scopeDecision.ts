// Scope-decision provenance (issue #1108).
//
// nanobpm/nano-bpm PR 1984 shipped about a quarter of nanobpm/nano-bpm#1960, still said
// `Closes #1960`, and auto-merged. Its body claimed "MVP scope agreed on escalation" — but that
// escalation was answered by the escalation-steward AGENT, not the operator, and the scope classifier
// treated any answer as an authoritative human ruling. Who answered is therefore recorded from the
// completion's AUTH identity (the `task_completions` ledger row the canonical
// `completeUserTaskAttributed` door writes — `human` for the UI / d8ctl operator path, `agent` for the
// steward), never from free text in the answer.
//
// This module is the ONE mapping from a ledger actor kind to the `answeredBy` value the convergence
// loop carries into the scope classifier (`scopeAnsweredBy`), plus the visible "scope reduced by agent
// decision" note the loop posts on the PR and its linked issues when a scope escalation was answered
// by anything other than the operator.
import { parseLinkedIssueNumbers, SCOPE_DECISION_NOTE_MARKER } from "./operatorFeedback.ts";

/** Who answered an escalation, derived from the completion's auth identity. `unknown` (no ledger row
 *  could be correlated) is deliberately NOT `operator`: an unattributed answer never counts as an
 *  operator decision. */
export type AnsweredBy = "operator" | "agent" | "unknown";

/** Map a `task_completions.actor_kind` (`human` / `agent`) to {@link AnsweredBy}. Anything else —
 *  including a missing row — is `unknown`, which fails safe (treated as non-operator). */
export function answeredByFromActorKind(kind: string | null | undefined): AnsweredBy {
  if (kind === "human") return "operator";
  if (kind === "agent") return "agent";
  return "unknown";
}

/** Whether a scope decision carries operator authority. Only an operator-answered escalation may be
 *  honoured as a ruling that changes what a closing keyword is allowed to close. */
export function isOperatorDecision(answeredBy: string | null | undefined): boolean {
  return answeredBy === "operator";
}

/** The fixed prefix the convergence loop's `persist-escalation-scope` step stamps on every
 *  scope-integrity escalation question (resources/processes/convergence-loop.bpmn). It is the ONE
 *  marker by which host code recognises a scope escalation from its projected question. */
export const SCOPE_ESCALATION_PREFIX = "Scope integrity: ";

/** Whether a projected escalation question is a scope-integrity escalation. */
export function isScopeEscalationQuestion(question: string | null | undefined): boolean {
  return typeof question === "string" && question.startsWith(SCOPE_ESCALATION_PREFIX);
}

/** Whether a prior adjudication may be AUTO-REPLAYED onto a re-raised escalation (Copilot review of
 *  #1109). A scope escalation that recurs after a NON-operator answer means the classifier rejected
 *  that answer (it only honours operator rulings), so replaying it would just loop the rejected answer;
 *  such a recurrence is left for the operator. Every other escalation keeps the #806 replay. */
export function mayAutoReplayAdjudication(question: string | null | undefined, adjudicatorKind: string | null | undefined): boolean {
  if (!isScopeEscalationQuestion(question)) return true;
  return adjudicatorKind === "human";
}

/** The visible note posted when a scope escalation was answered by an agent (or an unattributed
 *  completer) rather than the operator. */
export function agentScopeDecisionNote(input: { prUrl: string; answeredBy: AnsweredBy; answer: string | undefined }): string {
  const who = input.answeredBy === "agent" ? "an agent (not the operator)" : "an unattributed completer (not a verified operator)";
  const quoted = (input.answer ?? "(no answer text)").split("\n").map((l) => `> ${l}`).join("\n");
  return [
    SCOPE_DECISION_NOTE_MARKER,
    "⚠️ **Scope reduced by agent decision.**",
    "",
    `The scope-integrity escalation on ${input.prUrl} was answered by ${who}. This is not an operator decision:`,
    "the PR may merge as a partial delivery, but it must not close a broader-scoped issue — it has to use",
    "`Part of #N` (not `Closes #N`), with the deferred remainder filed and linked as a follow-up.",
    "",
    "Answer recorded:",
    "",
    quoted,
  ].join("\n");
}

export interface ScopeNoteDeps {
  /** Every PR text the scope classifier reads closing keywords from — title, body, and every commit
   *  message — so the note reaches each issue a closing keyword anywhere in the PR would affect. */
  prReferenceText: (repo: string, prNumber: number) => Promise<string>;
  /** Post a comment on a PR or issue (GitHub treats both as issues for comments). */
  comment: (repo: string, number: number, body: string) => Promise<void>;
}

/** Post the agent-decision note on the PR and on every same-repo issue its title, body, or commit
 *  messages link. Best-effort:
 *  each post's failure is swallowed (and reported in the result) so a GitHub hiccup never fails the
 *  answer reconcile. Returns the numbers it posted on. */
export async function postAgentScopeDecisionNote(
  input: { repo: string; prNumber: number; prUrl: string; answeredBy: AnsweredBy; answer: string | undefined },
  deps: ScopeNoteDeps,
): Promise<{ posted: number[]; failed: number[] }> {
  const note = agentScopeDecisionNote(input);
  let issues: number[] = [];
  try {
    issues = parseLinkedIssueNumbers(await deps.prReferenceText(input.repo, input.prNumber), input.repo).filter((n) => n !== input.prNumber);
  } catch {
    issues = [];
  }
  const posted: number[] = [];
  const failed: number[] = [];
  for (const n of [input.prNumber, ...issues]) {
    try {
      await deps.comment(input.repo, n, note);
      posted.push(n);
    } catch {
      failed.push(n);
    }
  }
  return { posted, failed };
}
