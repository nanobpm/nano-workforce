// The canonical "PR opened" issue-link decision (issue #907).
//
// When a single-issue feature run delivers its PR, the claimed issue's comment thread must link to
// it: the agent posts `🤖 Starting work…` (resources/prompts/feature.md) but nothing ever said
// "PR opened: #N", so a reader saw the claim and then silence — and concluded the agent stalled
// (camunda/camunda#19090: the PR existed, opened by a retry, but the thread never showed it).
//
// This module is the ONE host-side writer (derivation over duplication — NOT a second instruction
// in each prompt). `pr.record-feature` calls it on the run's delivery point, which EVERY
// PR-delivering path passes through: the agent's own `opened`, a retry's `opened`, and the
// implement-cell reconcile step's ADOPTED `opened` (app/implementReconcile.ts) all converge there.
//
// Gating mirrors the claim rule: only when the run seeded `claimIssue: true` (a single-issue
// feature run — app/feature.ts). An epic slice never sets it, so a wave slice NEVER comments on
// the shared parent epic.
//
// Idempotence is two-layered:
//   1. DURABLE RECORD — `feature_runs.pr_linked_pr_key` (migration 125) holds the PR key the link
//      was posted for. It is claimed with a guarded CAS UPDATE **before** the GitHub write, so two
//      racing passes can never both post; a repeated pass for the same PR short-circuits on the
//      record without touching GitHub.
//   2. MARKER SCAN — each comment carries a hidden `<!-- nwf:pr-linked:#n -->` marker. Before
//      posting, the issue's comments are listed and scanned for THIS PR's marker. This heals the
//      crash window between a successful POST and the claim landing (the next pass sees the marker
//      and records the claim instead of double-posting), and covers rows that predate the column.
//
// Best-effort throughout: any failure (no row, CAS failure, GitHub list/post failure, no
// transport) resolves to a status string and NEVER throws — a comment must never fail the run.
// A failed POST releases the claim so a later pass retries; a failed LIST keeps the claim (posting
// blind could double-post; the marker scan on the next pass is the safety net).
import type { DataLayer } from "@nanobpm/urban";
import { featureRuns } from "./feature.ts";
import { fetchPrMeta, runGh, useGh } from "./github.ts";

/** The hidden per-PR dedupe marker prefix carried by every PR-opened comment. The full marker is
 *  `<!-- nwf:pr-linked:#<number> -->`; scanning for it makes a repeated pass idempotent even when
 *  the durable claim was lost (crash between the POST and the record write). */
export const ISSUE_PR_LINK_MARKER_PREFIX = "<!-- nwf:pr-linked:#";

/** The discriminated outcome of a link attempt — logged by the caller so a skipped/failed link is
 *  observable without ever failing the run. */
export type IssuePrLinkOutcome =
  | "posted" // the comment was posted and the claim recorded
  | "already-recorded" // the durable record already names this PR — no GitHub I/O at all
  | "already-marked" // the claim was lost but the marker scan found the comment — claim re-recorded
  | "claim-lost" // a concurrent pass won the CAS — the winner owns the comment
  | "post-failed" // GitHub rejected the comment — claim RELEASED so a later pass retries
  | "list-failed" // the marker scan was unreadable — claim KEPT, nothing posted blind
  | "skipped"; // not a claimed single-issue run, no PR, no row, or a guard failure

/** The PR being announced. `title` is best-effort (null when unreadable — the comment still names
 *  the number and links the URL). */
export interface IssuePrLinkPr {
  prKey: string;
  number: number;
  url: string;
  title?: string | null;
}

/** The comment body: one line naming the PR (number, optional title, URL) plus the hidden marker. */
export function prOpenedCommentBody(pr: { number: number; title?: string | null; url: string }): string {
  const title = typeof pr.title === "string" && pr.title.trim() !== "" ? ` — ${pr.title.trim()}` : "";
  return `🤖 Pull request opened: #${pr.number}${title}  (${pr.url})\n\n${ISSUE_PR_LINK_MARKER_PREFIX}${pr.number} -->`;
}

/** List the bodies of every comment on an issue (newest page size 100 — the marker is posted by
 *  this app, so it is recent). `null` when no transport is usable; THROWS on a transport failure
 *  so the caller can distinguish "unreadable" (keep the claim, post nothing) from "empty". */
async function listIssueCommentBodies(repo: string, issueNumber: number, token: string): Promise<string[] | null> {
  if (await useGh()) {
    const out = await runGh([
      "api",
      `repos/${repo}/issues/${issueNumber}/comments?per_page=100`,
      "--jq",
      ".[].body",
    ]);
    return out.split("\n").filter((l) => l.length > 0);
  }
  if (!token) return null;
  const r = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments?per_page=100`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  if (!r.ok) throw new Error(`github ${r.status} ${r.statusText}`.trim());
  // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
  const arr = (await r.json()) as { body?: string }[];
  return arr.map((c) => c.body ?? "");
}

/** Post one comment on an issue. Returns whether GitHub accepted it; `false` when no transport is
 *  usable or the gh transport rejected it. THROWS only on a genuine token-transport failure the
 *  caller treats as post-failed. */
async function postIssueComment(repo: string, issueNumber: number, body: string, token: string): Promise<boolean> {
  if (await useGh()) {
    try {
      await runGh(["issue", "comment", String(issueNumber), "--repo", repo, "--body", body]);
      return true;
    } catch {
      return false;
    }
  }
  if (!token) return false;
  const r = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ body }),
  });
  return r.ok;
}

export interface EnsureIssuePrLinkInput {
  /** The run's `feature_key` (`owner/repo#N`) — the durable record key. */
  featureKey: string;
  /** The repository the issue lives in (`owner/repo`). */
  repo: string;
  /** The claimed issue's number. */
  issueNumber: number;
  /** The delivered PR (null/undefined ⇒ nothing to announce). */
  pr: IssuePrLinkPr | null | undefined;
  /** The run's `claimIssue` seed — true ONLY for single-issue feature runs (app/feature.ts). */
  claimIssue: unknown;
}

/** Post the idempotent "PR opened" comment on the claimed issue of a single-issue feature run.
 *  See the module header for the gating, the two idempotence layers, and the best-effort contract.
 *  Resolves to the outcome (never throws). */
export async function ensureIssuePrLinkComment(
  input: EnsureIssuePrLinkInput,
  data: DataLayer,
  token: string = process.env.GITHUB_TOKEN ?? "",
): Promise<IssuePrLinkOutcome> {
  try {
    // Gate: claimed single-issue runs only, with a delivered PR. An epic slice (`claimIssue` unset)
    // and a blocked/skipped run (no PR) are a pure no-op — no state, no GitHub I/O.
    if (input.claimIssue !== true) return "skipped";
    const pr = input.pr;
    if (!pr) return "skipped";
    const row = await featureRuns(data).get(input.featureKey);
    if (!row) return "skipped";
    // Layer 1 — the durable record: a repeated pass for the SAME PR short-circuits here.
    if (row.pr_linked_pr_key === pr.prKey) return "already-recorded";
    // Claim the link BEFORE the GitHub write (guarded CAS — only an unclaimed or differently-claimed
    // row flips), so two racing passes can never both post.
    const ts = new Date().toISOString();
    const claim = await data
      .open()
      .exec(
        `UPDATE "feature_runs" SET "pr_linked_pr_key" = ?, "updated_at" = ? WHERE "feature_key" = ? AND ("pr_linked_pr_key" IS NULL OR "pr_linked_pr_key" != ?)`,
        [pr.prKey, ts, input.featureKey, pr.prKey],
      );
    if (claim.changed === 0) return "claim-lost";
    // Layer 2 — the marker scan heals a lost claim (a prior pass posted and crashed): never
    // double-post a PR whose marker is already on the issue.
    let bodies: string[] | null;
    try {
      bodies = await listIssueCommentBodies(input.repo, input.issueNumber, token);
    } catch {
      // The scan is UNREADABLE — posting blind could double-post. Keep the claim (the marker scan
      // on a later pass is the safety net) and post nothing.
      return "list-failed";
    }
    const marker = `${ISSUE_PR_LINK_MARKER_PREFIX}${pr.number} -->`;
    if (bodies?.some((b) => b.includes(marker))) return "already-marked";
    // The title is best-effort: an explicit one wins; otherwise read the PR's title (never block the
    // comment on it — a failed read just omits the title).
    let title = pr.title ?? null;
    if (title == null) {
      try {
        title = (await fetchPrMeta(input.repo, pr.number, token))?.title ?? null;
      } catch {
        title = null;
      }
    }
    const posted = await postIssueComment(
      input.repo,
      input.issueNumber,
      prOpenedCommentBody({ number: pr.number, title, url: pr.url }),
      token,
    );
    if (!posted) {
      // The comment never landed — RELEASE the claim so a later pass retries the link.
      try {
        await data
          .open()
          .exec(
            `UPDATE "feature_runs" SET "pr_linked_pr_key" = NULL, "updated_at" = ? WHERE "feature_key" = ? AND "pr_linked_pr_key" = ?`,
            [ts, input.featureKey, pr.prKey],
          );
      } catch {
        // A failed release leaves the claim standing; the marker scan still heals a double-post.
      }
      return "post-failed";
    }
    return "posted";
  } catch {
    // Best-effort: a comment must never fail the run.
    return "skipped";
  }
}
