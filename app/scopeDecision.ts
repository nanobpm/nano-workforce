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
/** The per-decision dedupe marker: scoped to the ORIGINATING PR and the escalation that was answered,
 *  so a note for PR A never suppresses PR B's note on a shared issue, and a distinct answer (a new
 *  escalation) on the same PR is recorded too. The generic {@link SCOPE_DECISION_NOTE_MARKER} stays in
 *  the body for operator-feedback exclusion. */
export function scopeDecisionNoteKey(input: { repo: string; prNumber: number; decisionId?: string | number | null }): string {
  const id = String(input.decisionId ?? "unknown").replace(/[^A-Za-z0-9_.-]/g, "_");
  const repo = input.repo.replace(/[^A-Za-z0-9_./-]/g, "_");
  return `<!-- nwf:scope-agent-decision-key ${repo}#${input.prNumber}:${id} -->`;
}

export function agentScopeDecisionNote(input: { prUrl: string; answeredBy: AnsweredBy; answer: string | undefined; key?: string }): string {
  const who = input.answeredBy === "agent" ? "an agent (not the operator)" : "an unattributed completer (not a verified operator)";
  // The answer is agent-authored free text landing in a PRIVILEGED (app-token) comment: render it inert
  // in a fenced code block whose fence is longer than any backtick run in the text, so it cannot close
  // the fence, @mention anyone, or inject markdown (operator assessment of #1109).
  const text = input.answer ?? "(no answer text)";
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const quoted = `${fence}text\n${text}\n${fence}`;
  return [
    SCOPE_DECISION_NOTE_MARKER,
    ...(input.key ? [input.key] : []),
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
  /** Whether `number` in `repo` is an OPEN ISSUE (not a PR, not closed) — only those get the note. */
  isOpenIssue: (repo: string, number: number) => Promise<boolean>;
  /** Whether the PR/issue already carries a comment containing `key` (the per-decision
   *  {@link scopeDecisionNoteKey}) — idempotency across redelivery / crash-retry. */
  hasNote: (repo: string, number: number, key: string) => Promise<boolean>;
}

/** Hard cap on linked-issue targets the privileged note is posted on (besides the PR itself). */
export const MAX_SCOPE_NOTE_ISSUES = 10;
/** Hard cap on candidate references INSPECTED (each costs a GitHub lookup), so references to closed
 *  issues/PRs cannot drive an unbounded number of serial lookups. */
export const MAX_SCOPE_NOTE_CANDIDATES = 20;
/** Total wall-clock budget for the whole note operation (lookups + posts). */
export const SCOPE_NOTE_BUDGET_MS = 120_000;

// Per-PR serialisation of note posting so two in-process deliveries of the same answer cannot both pass
// the marker check before either posts.
const noteLocks = new Map<string, Promise<unknown>>();
function withNoteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = noteLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  noteLocks.set(key, tail);
  void tail.then(() => {
    if (noteLocks.get(key) === tail) noteLocks.delete(key);
  });
  return next;
}

/** Post the agent-decision note on the PR and on every same-repo issue its title, body, or commit
 *  messages link. Best-effort:
 *  each post's failure is swallowed (and reported in the result) so a GitHub hiccup never fails the
 *  answer reconcile. Returns the numbers it posted on. */
export async function postAgentScopeDecisionNote(
  input: { repo: string; prNumber: number; prUrl: string; answeredBy: AnsweredBy; answer: string | undefined; decisionId?: string | number | null },
  deps: ScopeNoteDeps,
  opts: { budgetMs?: number; now?: () => number } = {},
): Promise<{ posted: number[]; failed: number[] }> {
  return withNoteLock(`${input.repo}#${input.prNumber}`, async () => {
    const now = opts.now ?? Date.now;
    const deadline = now() + (opts.budgetMs ?? SCOPE_NOTE_BUDGET_MS);
    const key = scopeDecisionNoteKey(input);
    const note = agentScopeDecisionNote({ ...input, key });
    let candidates: number[] = [];
    try {
      candidates = parseLinkedIssueNumbers(await deps.prReferenceText(input.repo, input.prNumber), input.repo)
        .filter((n) => n !== input.prNumber)
        .slice(0, MAX_SCOPE_NOTE_CANDIDATES);
    } catch {
      candidates = [];
    }
    // Keep only same-repo OPEN ISSUES, capped, so a PR body cannot fan a privileged write out to
    // arbitrary PRs/closed issues or an unbounded number of targets.
    const issues: number[] = [];
    for (const n of candidates) {
      if (issues.length >= MAX_SCOPE_NOTE_ISSUES || now() >= deadline) break;
      try {
        if (await deps.isOpenIssue(input.repo, n)) issues.push(n);
      } catch {
        // unverifiable target: skip (fail closed)
      }
    }
    const posted: number[] = [];
    const failed: number[] = [];
    for (const n of [input.prNumber, ...issues]) {
      if (now() >= deadline) {
        failed.push(n);
        continue;
      }
      try {
        if (await deps.hasNote(input.repo, n, key)) continue;
        await deps.comment(input.repo, n, note);
        posted.push(n);
      } catch {
        failed.push(n);
      }
    }
    return { posted, failed };
  });
}
