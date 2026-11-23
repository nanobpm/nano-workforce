// Human assessment of a Copilot "Needs a closer look" verdict (issue #1037).
//
// A head-current 🔵 "Needs a closer look" review with no open thread and no open-issue count is a
// request for a HUMAN assessment. It has no thread to fix, and an agent push cannot clear it: every
// new head gets a fresh review that is free to say the same thing. Routing it to the convergence
// path (a fix round) or back to the merge attempt spins forever. This module is the ONE canonical
// place that decides "this verdict needs a human", records/reads the human's acceptance for a head,
// and words the escalation — shared by the merge backstop (`pr.merge`) and the converge-gate.
import type { IssueComment } from "./issuePrLink.ts";
import { ASSESSMENT_ACCEPT_LINE_RE, isTrustedAuthor } from "./operatorFeedback.ts";
import { HUMAN_ASSESSMENT_WAIT_OUTCOME } from "./reviewWait.ts";

/** The open-finding label `parseReviewOpenFindings` emits for the 🔵 verdict (app/github.ts). */
export const NEEDS_CLOSER_LOOK = "needs a closer look";

/** The merge-audit outcome the backstop records when it parks a head on a human assessment. */
export const HUMAN_ASSESSMENT_OUTCOME = HUMAN_ASSESSMENT_WAIT_OUTCOME;

/** The marker a trusted human posts on the PR to accept the verdict for one head. */
export const ASSESSMENT_ACCEPT_PREFIX = "nano-assessment: accept";

/** Pure: the PR-comment line that records a human acceptance of `head`. */
export function assessmentAcceptMarker(head: string): string {
  return `${ASSESSMENT_ACCEPT_PREFIX} ${head}`;
}

/** Pure: is the ONLY thing blocking a head-current review the "Needs a closer look" verdict? True
 * only when the (reconciled) findings are exactly that verdict AND the live thread set is READABLE
 * with no unresolved thread. Anything else (a count, "changes recommended", an open thread, an
 * unreadable thread set) stays on the ordinary findings path — fail closed. */
export function isAssessmentOnly(
  findings: readonly string[],
  threads: readonly { isResolved: boolean }[] | null,
): boolean {
  if (findings.length === 0) return false;
  if (!findings.every((f) => f === NEEDS_CLOSER_LOOK)) return false;
  if (threads === null) return false;
  return threads.every((t) => t.isResolved);
}

/** Pure: has a trusted, non-bot human accepted the verdict for `head` with a line that STARTS with
 * `nano-assessment: accept <sha>` (sha ≥ 7 hex chars, a prefix of `head`)? Quoted (`>`) and
 * mid-sentence markers do not count; nor do markers for a different head. */
export function isAssessmentAccepted(comments: readonly IssueComment[], head: string): boolean {
  return assessmentAcceptor(comments, head) !== null;
}

/** Pure: classify a human's escalation answer. `accept` requires an EXACT acceptance command
 * (accept / accepted / approve / approved / lgtm / merge / land, optional trailing `.`/`!`) — any
 * conditional or negative prose ("accept only after fixing…", "merge is not safe") is NOT
 * acceptance and stays unrecognised (fail closed); `fix` (`fix: <instructions>` / `fix …`) re-enters convergence carrying the
 * answer as instructions; anything else is unrecognised (null). */
export function classifyAssessmentAnswer(answer: string | null | undefined): "accept" | "fix" | null {
  const a = (answer ?? "").trim().toLowerCase();
  if (a === "") return null;
  if (/^(?:accept(?:ed)?|approved?|lgtm|merge|land)[.!]?$/.test(a)) return "accept";
  if (/^fix\b/.test(a)) return "fix";
  return null;
}

/** The escalation question for a head parked on a human assessment, quoting the verdict.
 *
 * `channel` names where the human's decision is actually READ (issue #1037 adversarial review):
 *  - `"answer"` (default, pr.merge): the merge stage records the parked head and honours an
 *    escalation reply of "accept" / "fix: …", so both the reply and the PR-comment marker are offered.
 *  - `"comment"` (converge-gate): the convergence escalation path never reads `answer` as an
 *    acceptance — only the `nano-assessment: accept <sha>` PR comment clears the gate. Offering
 *    "reply accept" there would send the operator round the same spin, so ONLY the marker is offered. */
export function assessmentQuestion(args: {
  repo: string;
  prNumber: number;
  head: string;
  verdict: string;
  channel?: "answer" | "comment";
}): string {
  const sha7 = args.head.slice(0, 7);
  const lead =
    `The head-current Copilot review of ${args.head} says "Needs a closer look" with no open thread and no ` +
    `open-issue count — it asks for a HUMAN assessment, which no agent push can clear. ` +
    (args.verdict ? `Reviewer verdict: "${args.verdict}". ` : "");
  if (args.channel === "comment") {
    return (
      lead +
      `Assess the change, then post a PR comment on ${args.repo}#${args.prNumber} starting ` +
      `\`${assessmentAcceptMarker(sha7)}\` to accept this head (${sha7}) as-is — that comment is the ONLY ` +
      `way to clear this gate (an escalation reply of "accept" is NOT read here). To request changes ` +
      `instead, reply with your instructions and the next round will act on them.`
    );
  }
  return (
    lead +
    `Assess the change, then reply "accept" to land this head (${sha7}) as-is, or "fix: <instructions>" to send it ` +
    `back to convergence with your instructions. (Equivalent: a PR comment starting ` +
    `\`${assessmentAcceptMarker(sha7)}\` on ${args.repo}#${args.prNumber} accepts this head.)`
  );
}

/** Pure: the trusted, non-bot author of the newest-first acceptance marker for `head`, or null. The
 * attribution the poller stamps when it resumes a parked assessment from a PR comment, so the resumed
 * completion is a first-hand HUMAN decision by the person who posted the marker. */
export function assessmentAcceptor(comments: readonly IssueComment[], head: string): string | null {
  const h = head.trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(h)) return null;
  for (const c of comments) {
    if (!isTrustedAuthor(c.association, c.login)) continue;
    for (const line of (c.body ?? "").split(/\r?\n/)) {
      const m = ASSESSMENT_ACCEPT_LINE_RE.exec(line);
      if (!m) continue;
      // Either side may be the abbreviated sha (both are ≥ 7 hex chars): a short marker accepts the full
      // head, and a full-sha marker accepts the short head an escalation question names.
      const marked = m[1].toLowerCase();
      if (h.startsWith(marked) || marked.startsWith(h)) return c.login;
    }
  }
  return null;
}

/** Pure: is this escalation question a human-assessment park, and for which head (the sha prefix it
 * names)? Derived from the ONE question builder above (`assessmentQuestion` always embeds the accept
 * marker), so the automated completers (steward, adjudication replay) and the marker resume share one
 * recognition rule with the writer. Null for any other question. */
export function assessmentHeadFromQuestion(question: string | null | undefined): string | null {
  // Read ONLY the builder-controlled head declaration at the very start of the question — never the
  // first marker anywhere in it, which could come from the quoted (reviewer-authored) verdict excerpt
  // and name an OLD head whose historical acceptance would then authorize the current one.
  const m = /^The head-current Copilot review of ([0-9a-f]{7,64}) says "Needs a closer look"/i.exec(question ?? "");
  return m ? m[1].toLowerCase() : null;
}

/** The token stamping a `fix` assessment's `review-findings` audit row with its winning completion id,
 * so a redelivered `pr.merge` job replays that verified decision instead of re-opening the assessment. */
export function assessmentFixCompletionToken(completionId: number): string {
  return `[assessment-completion:${completionId}]`;
}

/** Pure: the completion id stamped by `assessmentFixCompletionToken`, or null. */
export function assessmentFixCompletionId(detail: string | null | undefined): number | null {
  const m = /\[assessment-completion:(\d+)\]/.exec(detail ?? "");
  return m ? Number(m[1]) : null;
}

/** One `task_completions` ledger row, narrowed to what acceptance verification reads. */
export interface AssessmentCompletionRow {
  element_id: string | null;
  process_instance_key: string | null;
  actor_kind: string;
  auto_applied?: number | null;
  reverted: number;
  variables_json: string;
  created_at: string;
}

/** Pure: the answer a HUMAN gave to THIS parked assessment, or null when `row` does not prove one.
 * Requires the exact winning completion (looked up by the resumed token's `completedCompletionId`) to be
 * a first-hand (not auto-applied, not reverted) human completion of `elementId` on THIS process
 * instance, recorded AFTER the park. A redelivered job carrying a stale inherited `answer`, an
 * agent/steward answer, or an auto-applied adjudication replay never counts (fail closed). */
export function verifiedAssessmentAnswer(
  row: AssessmentCompletionRow | null | undefined,
  expect: { elementId: string; processInstanceKey: string; parkedAt: string },
): string | null {
  if (!row) return null;
  if (row.actor_kind !== "human") return null;
  if (Number(row.auto_applied ?? 0) !== 0 || Number(row.reverted) !== 0) return null;
  if (row.element_id !== expect.elementId) return null;
  if (expect.processInstanceKey === "" || String(row.process_instance_key ?? "") !== expect.processInstanceKey) return null;
  // `>=`: an in-process resume can land in the same millisecond as the park; a stale completion from an
  // EARLIER park always precedes the job activation that wrote this park row.
  if (!(String(row.created_at) >= expect.parkedAt)) return null;
  try {
    const v: unknown = JSON.parse(row.variables_json);
    const answer = v !== null && typeof v === "object" && "answer" in v ? v.answer : undefined;
    return typeof answer === "string" && answer.trim() !== "" ? answer.trim() : null;
  } catch {
    return null;
  }
}
