// Human assessment of a Copilot "Needs a closer look" verdict (issue #1037).
//
// A head-current 🔵 "Needs a closer look" review with no open thread and no open-issue count is a
// request for a HUMAN assessment. It has no thread to fix, and an agent push cannot clear it: every
// new head gets a fresh review that is free to say the same thing. Routing it to the convergence
// path (a fix round) or back to the merge attempt spins forever. This module is the ONE canonical
// place that decides "this verdict needs a human", records/reads the human's acceptance for a head,
// and words the escalation — shared by the merge backstop (`pr.merge`) and the converge-gate.
import type { IssueComment } from "./issuePrLink.ts";
import { isTrustedAuthor } from "./operatorFeedback.ts";
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
  const h = head.trim().toLowerCase();
  if (h === "") return false;
  const re = /^nano-assessment:[ \t]+accept[ \t]+([0-9a-f]{7,64})\b/i;
  for (const c of comments) {
    if (!isTrustedAuthor(c.association, c.login)) continue;
    for (const line of (c.body ?? "").split(/\r?\n/)) {
      const m = re.exec(line);
      if (m && h.startsWith(m[1].toLowerCase())) return true;
    }
  }
  return false;
}

/** Pure: classify a human's escalation answer. `accept` (accept / approve / lgtm / merge) lands the
 * PR on that head; `fix` (`fix: <instructions>` / `fix …`) re-enters convergence carrying the
 * answer as instructions; anything else is unrecognised (null). */
export function classifyAssessmentAnswer(answer: string | null | undefined): "accept" | "fix" | null {
  const a = (answer ?? "").trim().toLowerCase();
  if (a === "") return null;
  if (/^(?:accept(?:ed)?|approve[d]?|lgtm|merge|land)\b/.test(a)) return "accept";
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
