// Operator feedback — the ONE derivation of "trusted human feedback the run must address" (issue #985).
//
// Operators use the issue and the PR as the shared bus (scope corrections, "also handle X", a
// maintainer's change request). Before #985 that feedback was silently dropped: the implement prompt
// read the issue with plain `gh issue view` (body + a comment COUNT, not the comments), and the
// convergence gate only consulted PR review threads and Copilot advisories — so a run converged and
// merged with an operator's comment unaddressed.
//
// Two layers, both derived from THIS module so they cannot drift apart:
//   1. Read comments at the start — `issueReadCommand` is the single form every agent-facing issue
//      read instruction uses (`gh issue view <n> -R <repo> --comments`).
//   2. Treat new trusted feedback as review feedback — `deriveOperatorFeedback` is the single function
//      the converge gate uses BOTH to block convergence (unacknowledged items) AND to render the brief
//      injected into the review-round agent's prompt (`renderOperatorFeedbackBrief`).
//
// Feedback sources, all treated the same:
//   • issue comments on each issue the PR CLOSES (closing keyword), posted after the run started;
//   • PR conversation comments (the PR is created by the run, so every one post-dates the start);
//   • unresolved PR review THREADS whose root author is a trusted human (not a bot such as Copilot).
// An item is acknowledged by an `nano-ack: issuecomment-<id>` marker in any trusted-or-self reply on
// the issue or the PR conversation (a review thread is acknowledged by RESOLVING it). An
// unacknowledged item blocks convergence on the RECOVERABLE (ack-only) route: re-enter the round
// agent within the existing `ackRetryMax` budget, then escalate to a human.
//
// Epic slices (decision, documented in the PR): only issues the PR CLOSES are scanned. An epic slice
// links its parent with a non-closing `Part of #N`, so the parent epic's comments are ADVISORY for a
// slice — every slice still reads them at start (`--comments`), but they do not gate each slice's
// convergence (a single epic comment cannot sensibly block N unrelated slices; an operator who needs
// a slice to change comments on its PR, which IS gated).

import { ISSUE_PR_LINK_MARKER_PREFIX, type IssueComment } from "./issuePrLink.ts";
import { parsePr } from "./prParse.ts";

/** The ONE agent-facing issue-read command: reads the body AND every comment. Plain `gh issue view`
 *  prints only a comment count, which is how operator comments were silently dropped (#985). */
export function issueReadCommand(issueNumber: number | string, repo: string): string {
  return `gh issue view ${issueNumber} -R ${repo} --comments`;
}

/** The claim comment prefix the implement agent posts on a first run (resources/prompts/feature.md).
 *  Its earliest occurrence is the run's start time on the issue. */
export const CLAIM_COMMENT_PREFIX = "🤖 Starting work on this issue";

/** The line-stable acknowledgement marker for an operator comment. */
export function feedbackAckMarker(commentId: number): string {
  return `nano-ack: issuecomment-${commentId}`;
}

const ACK_RE = /nano-ack:\s*issuecomment-(\d+)/g;

/** Every comment id acknowledged by a `nano-ack: issuecomment-<id>` marker in the given bodies. */
export function parseFeedbackAcks(bodies: string[]): Set<number> {
  const out = new Set<number>();
  for (const b of bodies) for (const m of b.matchAll(ACK_RE)) out.add(Number(m[1]));
  return out;
}

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** A bot login (`…[bot]`, or the Copilot display login). */
export function isBotLogin(login: string): boolean {
  return login.endsWith("[bot]") || login === "Copilot";
}

/** A trusted human author: repo owner / org member / collaborator, never a bot. */
export function isTrustedAuthor(association: string | null | undefined, login: string | null | undefined): boolean {
  if (!login || isBotLogin(login)) return false;
  return TRUSTED_ASSOCIATIONS.has(String(association ?? "").toUpperCase());
}

/** A comment the run itself (or its host) wrote: the claim, the PR-link announcement, or an ack reply.
 *  The agent posts under the operator's own credentials, so authorship cannot tell these apart — the
 *  content markers do. */
export function isRunOwnComment(body: string): boolean {
  return (
    body.trimStart().startsWith(CLAIM_COMMENT_PREFIX) ||
    body.includes(ISSUE_PR_LINK_MARKER_PREFIX) ||
    /nano-ack:/.test(body)
  );
}

/** The run's start on an issue: the earliest claim comment, else the fallback (the PR's creation). */
export function runStartOnIssue(comments: IssueComment[], fallbackIso: string | null): string | null {
  const claims = comments.filter((c) => c.body.trimStart().startsWith(CLAIM_COMMENT_PREFIX)).map((c) => c.createdAt);
  claims.sort();
  return claims[0] ?? fallbackIso;
}

/** Issue numbers the PR CLOSES (`Closes/Fixes/Resolves #N` or `owner/repo#N` in the same repo), from
 *  its title and body. Non-closing refs (`Part of #N`, `Refs #N`) are excluded by construction. */
export function parseClosingIssueNumbers(text: string, repo: string): number[] {
  // The keyword is followed by one reference token; a bare `#N` is this repo, and a qualified
  // `owner/repo#N` is resolved through the ONE `owner/repo#N` grammar (`parsePr`) — no second shape regex.
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+(\S+)/gi;
  const out = new Set<number>();
  for (const m of text.matchAll(re)) {
    const token = m[1].replace(/[.,;:)]+$/, "");
    if (/^#\d+$/.test(token)) out.add(Number(token.slice(1)));
    else {
      const ref = parsePr(token);
      if (ref && ref.repo.toLowerCase() === repo.toLowerCase()) out.add(ref.number);
    }
  }
  return [...out];
}

/** A review thread as the feedback derivation needs it (root author + resolution). */
export interface FeedbackThread {
  isResolved: boolean;
  path: string | null;
  bodies: string[];
  rootLogin?: string | null;
  rootAssociation?: string | null;
}

/** An UNRESOLVED review thread rooted by a trusted human (not a bot such as Copilot) — operator
 *  feedback, acknowledged by resolving it. Shared by the derivation and the gate's thread split. */
export function isOperatorThread(t: FeedbackThread): boolean {
  return !t.isResolved && isTrustedAuthor(t.rootAssociation, t.rootLogin) && !isRunOwnComment(t.bodies[0] ?? "");
}

export interface OperatorFeedbackItem {
  /** `issue#N` / `pr` comment, or a review `thread`. */
  source: "issue" | "pr" | "thread";
  /** Comment id (0 for a thread — a thread is acknowledged by resolving it). */
  id: number;
  login: string;
  body: string;
  /** Human locator for block reasons / the brief. */
  label: string;
}

export interface OperatorFeedbackInput {
  repo: string;
  /** Comments per closing issue, with that issue's run start (comments at/before it are excluded). */
  issues: { number: number; comments: IssueComment[]; since: string | null }[];
  /** The PR's conversation comments (all post-date the run). */
  prComments: IssueComment[];
  /** The PR's review threads. */
  threads: FeedbackThread[];
}

/** The ONE derivation of outstanding operator feedback. Returns every UNACKNOWLEDGED trusted item:
 *  issue/PR comments lacking a `nano-ack: issuecomment-<id>` marker, and UNRESOLVED review threads
 *  rooted by a trusted human. Pure. */
export function deriveOperatorFeedback(input: OperatorFeedbackInput): OperatorFeedbackItem[] {
  const allBodies = [...input.prComments.map((c) => c.body), ...input.issues.flatMap((i) => i.comments.map((c) => c.body))];
  for (const t of input.threads) allBodies.push(...t.bodies);
  const acked = parseFeedbackAcks(allBodies);
  const items: OperatorFeedbackItem[] = [];
  const consider = (c: IssueComment, source: "issue" | "pr", label: string) => {
    if (!isTrustedAuthor(c.association, c.login)) return;
    if (isRunOwnComment(c.body)) return;
    if (acked.has(c.id)) return;
    items.push({ source, id: c.id, login: c.login, body: c.body, label });
  };
  for (const issue of input.issues) {
    for (const c of issue.comments) {
      if (issue.since !== null && !(c.createdAt > issue.since)) continue;
      consider(c, "issue", `${input.repo}#${issue.number} issuecomment-${c.id} by @${c.login}`);
    }
  }
  for (const c of input.prComments) consider(c, "pr", `PR issuecomment-${c.id} by @${c.login}`);
  for (const t of input.threads) {
    if (!isOperatorThread(t)) continue;
    items.push({
      source: "thread",
      id: 0,
      login: String(t.rootLogin),
      body: t.bodies[0] ?? "",
      label: `review thread on ${t.path ?? "the PR"} by @${t.rootLogin}`,
    });
  }
  return items;
}

const BRIEF_BODY_MAX = 2000;

/** The prompt section injected into the review-round agent for outstanding operator feedback. Empty
 *  string when there is none. */
export function renderOperatorFeedbackBrief(items: OperatorFeedbackItem[]): string {
  if (items.length === 0) return "";
  const lines = [
    "",
    "",
    "---",
    "",
    "## Operator feedback to address",
    "",
    "A trusted maintainer posted the feedback below after this run started. It is review feedback:",
    "change the code to address it, or reply explaining why not. Convergence is BLOCKED until each item",
    "is acknowledged:",
    "",
    "- an issue / PR comment: reply (on the same issue or on this PR) with a line containing its marker",
    "  `nano-ack: issuecomment-<id>` (shown below), stating what you did;",
    "- a review thread: address it, reply, and RESOLVE the thread.",
    "",
  ];
  for (const it of items) {
    const body = it.body.length > BRIEF_BODY_MAX ? `${it.body.slice(0, BRIEF_BODY_MAX)}…` : it.body;
    const marker = it.source === "thread" ? "resolve the thread" : `\`${feedbackAckMarker(it.id)}\``;
    lines.push(`### ${it.label} — ack: ${marker}`, "", body.split("\n").map((l) => `> ${l}`).join("\n"), "");
  }
  return lines.join("\n");
}
