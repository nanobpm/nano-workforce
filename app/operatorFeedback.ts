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
//   • unresolved PR review THREADS whose root author is a trusted human (not a bot such as Copilot);
//   • submitted PR REVIEW BODIES (`COMMENTED` / `CHANGES_REQUESTED`) by a trusted human, submitted
//     after the run started (issue #1039 — the "Submit review" summary with no inline comments).
// An item is acknowledged by a line STARTING with `nano-ack: issuecomment-<id>` (a review body:
// `nano-ack: review-<id>`) in a trusted-author comment on the issue or the PR conversation (a review
// thread is acknowledged by RESOLVING it). An
// unacknowledged item blocks convergence on the RECOVERABLE (ack-only) route: re-enter the round
// agent within the existing `ackRetryMax` budget, then escalate to a human.
//
// Epic slices (decision, documented in the PR): only issues the PR CLOSES are scanned. An epic slice
// links its parent with a non-closing `Part of #N`, so the parent epic's comments are ADVISORY for a
// slice — every slice still reads them at start (`--comments`), but they do not gate each slice's
// convergence (a single epic comment cannot sensibly block N unrelated slices; an operator who needs
// a slice to change comments on its PR, which IS gated).

import { parseIssue } from "./issueParse.ts";
import { ISSUE_PR_LINK_MARKER_PREFIX, type IssueComment } from "./issuePrLink.ts";

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

/** The line-stable acknowledgement marker for a submitted PR review body (issue #1039). */
export function reviewAckMarker(reviewId: number): string {
  return `nano-ack: review-${reviewId}`;
}

// A DEDICATED acknowledgement line: the marker must START a (non-quoted) line. A marker merely
// mentioned mid-sentence ("You posted nano-ack: issuecomment-42, but …") or quoted (`> nano-ack: …`)
// is NOT an ack — that is corrective feedback and must still gate.
const ACK_LINE_RE = /^nano-ack:\s*(issuecomment|review)-(\d+)\b/;

type AckKind = "issuecomment" | "review";

function ackLines(body: string): { kind: AckKind; id: number }[] {
  const out: { kind: AckKind; id: number }[] = [];
  for (const line of body.split("\n")) {
    const m = line.trim().match(ACK_LINE_RE);
    if (m) out.push({ kind: m[1] === "review" ? "review" : "issuecomment", id: Number(m[2]) });
  }
  return out;
}

function parseAcks(bodies: string[], kind: AckKind): Set<number> {
  const out = new Set<number>();
  for (const b of bodies) for (const a of ackLines(b)) if (a.kind === kind) out.add(a.id);
  return out;
}

/** Every comment id acknowledged by a dedicated `nano-ack: issuecomment-<id>` line in the bodies. */
export function parseFeedbackAcks(bodies: string[]): Set<number> {
  return parseAcks(bodies, "issuecomment");
}

/** Every review id acknowledged by a dedicated `nano-ack: review-<id>` line in the bodies. */
export function parseReviewAcks(bodies: string[]): Set<number> {
  return parseAcks(bodies, "review");
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
    ackLines(body).length > 0 ||
    // A Copilot-advisory ack thread root (`<verdict>. nano-ack: <path> :: <text>`, app/github.ts).
    /nano-ack:\s*\S+\s+::\s+\S/.test(body)
  );
}

/** The run's start on an issue: the earliest TRUSTED claim comment, else the fallback (the PR's
 *  creation). An untrusted/bot comment carrying the claim prefix is ignored, so an outsider cannot
 *  move the cutoff forward and hide a maintainer's post-start feedback from the brief and the gate. */
export function runStartOnIssue(comments: IssueComment[], fallbackIso: string | null): string | null {
  const claims = comments
    .filter((c) => c.body.trimStart().startsWith(CLAIM_COMMENT_PREFIX) && isTrustedAuthor(c.association, c.login))
    .map((c) => c.createdAt);
  claims.sort();
  return claims[0] ?? fallbackIso;
}

/** Issue numbers the PR CLOSES (`Closes/Fixes/Resolves #N` or `owner/repo#N` in the same repo), from
 *  its title and body. Non-closing refs (`Part of #N`, `Refs #N`) are excluded by construction. */
export function parseClosingIssueNumbers(text: string, repo: string): number[] {
  // The keyword is followed by one reference token; a bare `#N` is this repo, and a qualified
  // `owner/repo#N` is or an `/issues/` URL is resolved through the ONE issue grammar (`parseIssue`) — no second shape regex.
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+(\S+)/gi;
  const out = new Set<number>();
  for (const m of text.matchAll(re)) {
    const token = m[1].replace(/[.,;:)]+$/, "");
    if (/^#\d+$/.test(token)) out.add(Number(token.slice(1)));
    else {
      // `owner/repo#N` AND `https://github.com/owner/repo/issues/N` — the ONE issue grammar.
      const ref = parseIssue(token);
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

/** A submitted PR review (`GET /pulls/{n}/reviews`) as the feedback derivation needs it. */
export interface FeedbackReview {
  id: number;
  login: string;
  association: string;
  /** `COMMENTED`, `CHANGES_REQUESTED`, `APPROVED`, `DISMISSED`, `PENDING`. */
  state: string;
  body: string;
  submittedAt: string;
  url: string | null;
}

/** Narrow a raw GitHub review payload to a {@link FeedbackReview}. */
export function toFeedbackReview(r: unknown): FeedbackReview {
  const o: Record<string, unknown> = r !== null && typeof r === "object" ? { ...r } : {};
  const user: Record<string, unknown> = o.user !== null && typeof o.user === "object" ? { ...o.user } : {};
  return {
    id: typeof o.id === "number" ? o.id : 0,
    login: typeof user.login === "string" ? user.login : "",
    association: typeof o.author_association === "string" ? o.author_association : "NONE",
    submittedAt: typeof o.submitted_at === "string" ? o.submitted_at : "",
    body: typeof o.body === "string" ? o.body : "",
    state: typeof o.state === "string" ? o.state : "",
    url: typeof o.html_url === "string" ? o.html_url : null,
  };
}

const FEEDBACK_REVIEW_STATES = new Set(["COMMENTED", "CHANGES_REQUESTED"]);

export interface OperatorFeedbackItem {
  /** `issue#N` / `pr` comment, a review `thread`, or a submitted `review` body. */
  source: "issue" | "pr" | "thread" | "review";
  /** Comment / review id (0 for a thread — a thread is acknowledged by resolving it). */
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
  /** The PR's submitted reviews (issue #1039); bodies by trusted humans are feedback. */
  reviews?: FeedbackReview[];
  /** Run start for reviews (reviews at/before it are excluded); `null` = no cutoff. */
  reviewsSince?: string | null;
}

/** A line-start human-assessment acceptance marker (`nano-assessment: accept <sha>`, issue #1037).
 * The ONE pattern both the assessment reader (app/humanAssessment.ts) and the feedback derivation use. */
export const ASSESSMENT_ACCEPT_LINE_RE = /^nano-assessment:[ \t]+accept[ \t]+([0-9a-f]{7,64})\b/i;

/** Pure: a comment body with its consumed assessment-acceptance marker lines removed. Any OTHER
 * instruction in the same comment — including text after the marker on the same line — is preserved and still counts as operator feedback. */
export function stripAssessmentMarkers(body: string): string {
  return body
    .split(/\r?\n/)
    .flatMap((line) => {
      if (!ASSESSMENT_ACCEPT_LINE_RE.test(line)) return [line];
      const rest = line.replace(ASSESSMENT_ACCEPT_LINE_RE, "").replace(/^[ \t]*[;,:.-]?[ \t]*/, "");
      return rest.trim() === "" ? [] : [rest];
    })
    .join("\n")
    .trim();
}

/** The ONE derivation of outstanding operator feedback. Returns every UNACKNOWLEDGED trusted item:
 *  issue/PR comments lacking a `nano-ack: issuecomment-<id>` marker, and UNRESOLVED review threads
 *  rooted by a trusted human. Pure. */
export function deriveOperatorFeedback(input: OperatorFeedbackInput): OperatorFeedbackItem[] {
  // Acks count ONLY from trusted human issue/PR comments: an untrusted commenter must not be able to
  // forge `nano-ack: issuecomment-<id>` and clear a maintainer's feedback. Review-thread replies carry
  // no per-reply authorship here, so they are not an ack source (a thread is acked by resolving it).
  const ackBodies = [...input.prComments, ...input.issues.flatMap((i) => i.comments)]
    .filter((c) => isTrustedAuthor(c.association, c.login))
    .map((c) => c.body);
  // A trusted review body is an ack source too: the agent may post under the operator's identity.
  const trustedReviews = (input.reviews ?? []).filter((r) => isTrustedAuthor(r.association, r.login));
  // Only SUBMITTED reviews ack: GitHub returns the caller's own PENDING draft, which may be discarded.
  const submittedReviews = trustedReviews.filter((r) => r.state.toUpperCase() !== "PENDING" && r.submittedAt !== "");
  // ONE ack-source list feeds BOTH parsers (separate id namespaces), so a submitted review can ack
  // a comment exactly as a comment can ack a review.
  const ackSources = [...ackBodies, ...submittedReviews.map((r) => r.body)];
  const acked = parseFeedbackAcks(ackSources);
  const ackedReviews = parseReviewAcks(ackSources);
  const items: OperatorFeedbackItem[] = [];
  const consider = (c: IssueComment, source: "issue" | "pr", label: string) => {
    if (!isTrustedAuthor(c.association, c.login)) return;
    if (isRunOwnComment(c.body)) return;
    if (acked.has(c.id)) return;
    // An assessment-acceptance marker is consumed by the assessment gate, not feedback for an agent.
    const body = stripAssessmentMarkers(c.body ?? "");
    if (body === "") return;
    items.push({ source, id: c.id, login: c.login, body, label });
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
  const since = input.reviewsSince ?? null;
  for (const r of trustedReviews) {
    if (!FEEDBACK_REVIEW_STATES.has(r.state.toUpperCase())) continue;
    if (r.body.trim() === "") continue;
    if (since !== null && !(r.submittedAt > since)) continue;
    if (isRunOwnComment(r.body)) continue;
    if (ackedReviews.has(r.id)) continue;
    items.push({
      source: "review",
      id: r.id,
      login: r.login,
      body: r.body,
      label: `PR review-${r.id} by @${r.login}${r.url ? ` (${r.url})` : ""}`,
    });
  }
  return items;
}

/** The ack instruction for one item (the ONE place mapping a source to its ack form). */
function ackInstruction(it: OperatorFeedbackItem): string {
  if (it.source === "thread") return "resolve the thread";
  return `\`${it.source === "review" ? reviewAckMarker(it.id) : feedbackAckMarker(it.id)}\``;
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
    "- an issue / PR comment: reply (on the same issue or on this PR) with a line STARTING with its marker",
    "  `nano-ack: issuecomment-<id>` (shown below), stating what you did;",
    "- a PR review body (a submitted review's summary): reply in a PR conversation comment with a line",
    "  STARTING with `nano-ack: review-<id>` (shown below), stating what you did;",
    "- a review thread: address it, reply, and RESOLVE the thread.",
    "",
  ];
  for (const it of items) {
    const body = it.body.length > BRIEF_BODY_MAX ? `${it.body.slice(0, BRIEF_BODY_MAX)}…` : it.body;
    lines.push(`### ${it.label} — ack: ${ackInstruction(it)}`, "", body.split("\n").map((l) => `> ${l}`).join("\n"), "");
  }
  return lines.join("\n");
}

/** The ONE list of points at which a running implementation agent re-reads post-start issue comments
 *  (issue #986), so a course correction lands before the PR exists. `resources/prompts/feature.md`
 *  renders exactly these ids, in this order (guarded by app/operatorFeedback.test.ts). */
export const IMPLEMENT_FEEDBACK_CHECKPOINTS = ["after-planning", "before-first-push", "before-pr-open"] as const;
