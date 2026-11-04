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
// Durable state machine (migration 125) — three columns on `feature_runs`:
//   • `pr_link_want_pr_key` — the PR the issue is OWED a link for. Written by `requestIssuePrLink`
//     (pr.record-feature) ONLY for a claimed single-issue run with a keyed PR.
//   • `pr_linked_pr_key`    — CONFIRMED: written only after a successful POST or a marker match. A
//     pending/in-flight claim is NEVER mistaken for a confirmed link.
//   • `pr_link_lease_at`    — an EXPIRING in-flight lease, CAS-claimed before any GitHub I/O so two
//     racing passes never both post. On ANY failure (unreadable scan, rejected/thrown POST, crash)
//     the lease is simply left to expire — that is the retry backoff — and the poller's
//     `pollIssuePrLinks` pass (app/service.ts → `retryOutstandingIssuePrLinks`) re-attempts every
//     outstanding link through this same `attemptIssuePrLink`, so a transient failure never leaves
//     the delivered PR unannounced and never fails or restarts the run.
// Each comment also carries a hidden `<!-- nwf:pr-linked:#n -->` marker; the issue's comments are
// scanned (ALL pages) before posting, which heals a crash between a successful POST and the confirm.
//
// Targeting: the comment goes to the CLAIMED ISSUE (the run row's `repo` + `issue_number`), never
// to the PR's repository — a cross-repo PR is looked up (title) in its own repo only.
//
// Best-effort throughout: every path resolves to a status string and NEVER throws.
import type { DataLayer } from "@nanobpm/urban";
import { featureRuns } from "./feature.ts";
import { fetchPrMeta, runGh, useGh } from "./github.ts";
import { parsePr } from "./prParse.ts";

/** The hidden per-PR dedupe marker prefix carried by every PR-opened comment. The full marker is
 *  `<!-- nwf:pr-linked:#<number> -->`; scanning for it makes a repeated pass idempotent even when
 *  the durable claim was lost (crash between the POST and the record write). */
export const ISSUE_PR_LINK_MARKER_PREFIX = "<!-- nwf:pr-linked:#";

/** The discriminated outcome of a link attempt — logged by the caller so a skipped/failed link is
 *  observable without ever failing the run. */
export type IssuePrLinkOutcome =
  | "posted" // the comment was posted and the link confirmed
  | "already-recorded" // the confirmed record already names the owed PR — no GitHub I/O at all
  | "already-marked" // the marker scan found the comment — link confirmed without re-posting
  | "claim-lost" // another pass holds a live lease (or the CAS lost) — that pass owns the attempt
  | "post-failed" // GitHub rejected/threw on the POST — lease left to expire; the poller retries
  | "list-failed" // the marker scan was unreadable — nothing posted blind; the poller retries
  | "skipped"; // not a claimed single-issue run, no PR, no row, or a guard failure

/** The comment body: one line naming the PR (number, optional title, URL) plus the hidden marker. */
export function prOpenedCommentBody(pr: { number: number; title?: string | null; url: string }): string {
  const title = typeof pr.title === "string" && pr.title.trim() !== "" ? ` — ${pr.title.trim()}` : "";
  return `🤖 Pull request opened: #${pr.number}${title}  (${pr.url})\n\n${ISSUE_PR_LINK_MARKER_PREFIX}${pr.number} -->`;
}

/** How long an in-flight lease blocks other passes. A crash or failure leaves it to expire, after
 *  which the poller retries — so this is also the retry backoff. */
export const ISSUE_PR_LINK_LEASE_MS = 5 * 60 * 1000;

const PAGE_SIZE = 100;
/** Hard bound on pages scanned (10k comments) so a pathological issue can't loop forever. Hitting it
 *  is treated as UNREADABLE (fail closed: never post blind). */
const MAX_PAGES = 100;

/** List the bodies of EVERY comment on an issue, across all pages. `null` when no transport is
 *  usable; THROWS on a transport failure (or an over-long thread) so the caller can distinguish
 *  "unreadable" (post nothing) from "empty". */
async function listIssueCommentBodies(repo: string, issueNumber: number, token: string): Promise<string[] | null> {
  const ghMode = await useGh();
  if (!ghMode && !token) return null;
  const bodies: string[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const path = `repos/${repo}/issues/${issueNumber}/comments?per_page=${PAGE_SIZE}&page=${page}`;
    let arr: unknown;
    if (ghMode) {
      arr = JSON.parse(await runGh(["api", path]));
    } else {
      const r = await fetch(`https://api.github.com/${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      });
      if (!r.ok) throw new Error(`github ${r.status} ${r.statusText}`.trim());
      arr = await r.json();
    }
    if (!Array.isArray(arr)) throw new Error("github: unexpected comments payload");
    for (const c of arr) {
      const body = c !== null && typeof c === "object" && "body" in c ? c.body : "";
      bodies.push(typeof body === "string" ? body : "");
    }
    if (arr.length < PAGE_SIZE) return bodies;
  }
  throw new Error(`github: issue ${repo}#${issueNumber} has more than ${MAX_PAGES * PAGE_SIZE} comments`);
}

/** Post one comment on an issue. Returns whether GitHub accepted it; `false` when no transport is
 *  usable or EITHER transport rejected or threw (a connection failure is normalised, never thrown). */
async function postIssueComment(repo: string, issueNumber: number, body: string, token: string): Promise<boolean> {
  try {
    if (await useGh()) {
      await runGh(["issue", "comment", String(issueNumber), "--repo", repo, "--body", body]);
      return true;
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
  } catch {
    return false;
  }
}

export interface RequestIssuePrLinkInput {
  /** The run's `feature_key` (`owner/repo#N`) — the durable record key. */
  featureKey: string;
  /** The delivered PR key (null/undefined ⇒ nothing to announce). */
  prKey: string | null | undefined;
  /** The run's `claimIssue` seed — true ONLY for single-issue feature runs (app/feature.ts). */
  claimIssue: unknown;
}

/** Record that the claimed issue is OWED a "PR opened" link for `prKey`, then attempt it once.
 *  Called by pr.record-feature; a failed attempt is retried by the poller (`retryOutstandingIssuePrLinks`).
 *  Resolves to the outcome (never throws). */
export async function requestIssuePrLink(
  input: RequestIssuePrLinkInput,
  data: DataLayer,
  token: string = process.env.GITHUB_TOKEN ?? "",
): Promise<IssuePrLinkOutcome> {
  try {
    // Gate: claimed single-issue runs only, with a keyed PR. An epic slice (`claimIssue` unset) and a
    // blocked/skipped run (no PR) are a pure no-op — no state, no GitHub I/O.
    if (input.claimIssue !== true) return "skipped";
    if (!input.prKey || !parsePr(input.prKey)) return "skipped";
    const r = await data
      .open()
      .exec(`UPDATE "feature_runs" SET "pr_link_want_pr_key" = ? WHERE "feature_key" = ?`, [
        input.prKey,
        input.featureKey,
      ]);
    if (r.changed === 0) return "skipped";
    return await attemptIssuePrLink(input.featureKey, data, token);
  } catch {
    return "skipped";
  }
}

/** Attempt the OWED link for one run (the single canonical attempt, shared by record-feature and the
 *  poller retry). Never throws. */
export async function attemptIssuePrLink(
  featureKey: string,
  data: DataLayer,
  token: string = process.env.GITHUB_TOKEN ?? "",
  now: () => Date = () => new Date(),
): Promise<IssuePrLinkOutcome> {
  try {
    const row = await featureRuns(data).get(featureKey);
    if (!row) return "skipped";
    const want = row.pr_link_want_pr_key ?? null;
    const pr = want ? parsePr(want) : null;
    if (!want || !pr) return "skipped";
    // The confirmed record already names the owed PR — no GitHub I/O at all.
    if (row.pr_linked_pr_key === want) return "already-recorded";
    const issueRepo = typeof row.repo === "string" ? row.repo : "";
    const issueNumber = Number(row.issue_number);
    if (!issueRepo || !Number.isInteger(issueNumber) || issueNumber <= 0) return "skipped";
    // Claim an EXPIRING lease before any GitHub I/O (guarded CAS): only a free or expired lease, for
    // a still-owed and still-unconfirmed PR, flips — so two racing passes never both post.
    const t = now();
    const ts = t.toISOString();
    const expired = new Date(t.getTime() - ISSUE_PR_LINK_LEASE_MS).toISOString();
    const claim = await data
      .open()
      .exec(
        `UPDATE "feature_runs" SET "pr_link_lease_at" = ? WHERE "feature_key" = ? AND "pr_link_want_pr_key" = ? AND ("pr_linked_pr_key" IS NULL OR "pr_linked_pr_key" != ?) AND ("pr_link_lease_at" IS NULL OR "pr_link_lease_at" < ?)`,
        [ts, featureKey, want, want, expired],
      );
    if (claim.changed === 0) return "claim-lost";
    const confirm = async () => {
      await data
        .open()
        .exec(
          `UPDATE "feature_runs" SET "pr_linked_pr_key" = ?, "pr_link_lease_at" = NULL WHERE "feature_key" = ? AND "pr_link_lease_at" = ?`,
          [want, featureKey, ts],
        );
    };
    // The marker scan (every page) heals a crash between a successful POST and the confirm.
    let bodies: string[] | null;
    try {
      bodies = await listIssueCommentBodies(issueRepo, issueNumber, token);
    } catch {
      // UNREADABLE — posting blind could double-post. Leave the lease to expire; the poller retries.
      return "list-failed";
    }
    const marker = `${ISSUE_PR_LINK_MARKER_PREFIX}${pr.number} -->`;
    if (bodies?.some((b) => b.includes(marker))) {
      await confirm();
      return "already-marked";
    }
    // The title is best-effort, read from the PR's OWN repository.
    let title: string | null = null;
    try {
      title = (await fetchPrMeta(pr.repo, pr.number, token))?.title ?? null;
    } catch {
      title = null;
    }
    const posted = await postIssueComment(
      issueRepo,
      issueNumber,
      prOpenedCommentBody({ number: pr.number, title, url: pr.url }),
      token,
    );
    // A failure leaves the lease to expire (never confirmed) — the poller's retry pass re-attempts.
    if (!posted) return "post-failed";
    await confirm();
    return "posted";
  } catch {
    return "skipped";
  }
}

/** The poller retry pass: re-attempt every OUTSTANDING owed link (owed, unconfirmed, lease free or
 *  expired). Only rows pr.record-feature marked as owed are scanned — never pre-#907 rows or epic
 *  slices. Never throws. */
export async function retryOutstandingIssuePrLinks(
  data: DataLayer,
  token: string = process.env.GITHUB_TOKEN ?? "",
  now: () => Date = () => new Date(),
): Promise<Record<string, IssuePrLinkOutcome>> {
  const out: Record<string, IssuePrLinkOutcome> = {};
  try {
    const expired = new Date(now().getTime() - ISSUE_PR_LINK_LEASE_MS).toISOString();
    const rows = await data
      .open()
      .query<{ feature_key: string }>(
        `SELECT "feature_key" FROM "feature_runs" WHERE "pr_link_want_pr_key" IS NOT NULL AND ("pr_linked_pr_key" IS NULL OR "pr_linked_pr_key" != "pr_link_want_pr_key") AND ("pr_link_lease_at" IS NULL OR "pr_link_lease_at" < ?)`,
        [expired],
      );
    for (const r of rows) out[r.feature_key] = await attemptIssuePrLink(r.feature_key, data, token, now);
  } catch {
    // Best-effort: a link retry must never break the poll loop.
  }
  return out;
}
