// Unit coverage for the canonical "PR opened" issue-link decision (issue #907).
//
// When a single-issue feature run delivers its PR, the HOST posts one idempotent
// `🤖 Pull request opened: #n — …` comment on the claimed issue, so the issue thread links to the
// delivered PR even when the agent (or a retry, or the reconcile-adopt path) opened it without
// saying so. This module is the ONE writer (derivation over duplication): `pr.record-feature`
// calls it on the delivery point every PR-delivering path converges on.
//
// Idempotence is TWO-layered, and both layers are pinned here:
//   1. a durable `feature_runs.pr_linked_pr_key` record (survives restarts; CAS-claimed BEFORE the
//      GitHub write so a crash after the comment posts is healed by the marker scan, and a crashed
//      claim is retried next pass), and
//   2. a hidden `<!-- nwf:pr-linked:#n -->` marker scan of the issue comments (heals a run whose
//      comment posted but whose claim never persisted — e.g. a crash between the two — and covers
//      installs whose row predates the column).
//
// The GitHub reads/writes are hermetically stubbed via the pinned `token` transport + a fetch
// double (mirrors workers/reconcile-implement/worker.test.ts) — no `gh` subprocess, no network.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import {
  ensureIssuePrLinkComment,
  ISSUE_PR_LINK_MARKER_PREFIX,
  prOpenedCommentBody,
} from "./issuePrLink.ts";

// ── Fetch stub ────────────────────────────────────────────────────────────────

interface PostedComment {
  body: string;
}

/** A hermetic GitHub issues-comments API double: serves the seeded comment bodies on
 *  GET …/issues/{n}/comments and records POSTs (optionally failing them). */
function stubGithubComments(
  existing: { body: string }[],
  opts: { failList?: boolean; failPost?: boolean } = {},
): { posted: PostedComment[]; restore: () => void } {
  const prevTransport = process.env.NANO_PR_GITHUB_TRANSPORT;
  const prevToken = process.env.GITHUB_TOKEN;
  const prevFetch = globalThis.fetch;
  process.env.NANO_PR_GITHUB_TRANSPORT = "token";
  process.env.GITHUB_TOKEN = "t";
  const posted: PostedComment[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") {
      if (opts.failList) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify(existing), { status: 200 });
    }
    if (method === "POST") {
      if (opts.failPost) return new Response("boom", { status: 500 });
      // biome-ignore lint/plugin: runtime contract boundary for parsed JSON in a test double
      const body = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
      posted.push({ body: String(body.body ?? "") });
      return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return {
    posted,
    restore: () => {
      globalThis.fetch = prevFetch;
      if (prevTransport === undefined) delete process.env.NANO_PR_GITHUB_TRANSPORT;
      else process.env.NANO_PR_GITHUB_TRANSPORT = prevTransport;
      if (prevToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prevToken;
    },
  };
}

// ── DB double (feature_runs row + CAS claim) ─────────────────────────────────

interface FeatureRowDouble {
  feature_key: string;
  pr_linked_pr_key?: string | null;
}

/** The minimal DataLayer double the link step touches: `table("feature_runs").get` plus the
 *  `open().exec` CAS claim. `claimSucceeds` simulates the CAS outcome (false = another writer
 *  already claimed the link). The exec params are positional: [prKey, updated_at, featureKey, prKey]
 *  on the claim; [featureKey, prKey] on the release. */
function fakeData(
  row: FeatureRowDouble | null,
  opts: { claimSucceeds?: boolean; claimThrows?: boolean } = {},
): { data: never; claimAttempts: number } {
  let claimAttempts = 0;
  const data = {
    table: (name: string, _key: string) => {
      assertEquals(name, "feature_runs");
      return {
        get: (k: string) => Promise.resolve(row && row.feature_key === k ? { ...row } : null),
      };
    },
    open: () => ({
      exec: (sql: string, params: unknown[]) => {
        assert(
          /UPDATE "feature_runs" SET "pr_linked_pr_key" = /.test(sql),
          `the claim/release is a guarded CAS on pr_linked_pr_key (got: ${sql})`,
        );
        claimAttempts += 1;
        if (opts.claimThrows) throw new Error("db down");
        if (/SET "pr_linked_pr_key" = NULL/.test(sql)) {
          // The release (post-failed): params are [updated_at, featureKey, prKey].
          assertEquals(params[1], row?.feature_key, "the release is keyed on the feature run");
          if (row) row.pr_linked_pr_key = null;
          return { changed: 1 };
        }
        // The claim: params are [prKey, updated_at, featureKey, prKey].
        assertEquals(params[2], row?.feature_key, "the CAS is keyed on the feature run");
        const changed = opts.claimSucceeds === false ? 0 : 1;
        if (changed > 0 && row) row.pr_linked_pr_key = String(params[0]);
        return { changed };
      },
    }),
  };
  return { data: data as never, claimAttempts };
}

const RUN = { featureKey: "owner/repo#7", repo: "owner/repo", issueNumber: 7 };
const PR = { prKey: "owner/repo#101", number: 101, url: "https://github.com/owner/repo/pull/101" };

// ── Comment body ──────────────────────────────────────────────────────────────

test("the comment body carries the PR number, title, URL and the hidden dedupe marker", () => {
  const body = prOpenedCommentBody({ number: 101, title: "Add the thing", url: PR.url });
  assert(body.includes("Pull request opened: #101"), "names the PR number");
  assert(body.includes("Add the thing"), "names the PR title");
  assert(body.includes(PR.url), "links the PR URL");
  assert(
    body.includes(`${ISSUE_PR_LINK_MARKER_PREFIX}101 -->`),
    "carries the hidden per-PR dedupe marker",
  );
});

test("the comment body tolerates a missing title", () => {
  const body = prOpenedCommentBody({ number: 101, title: null, url: PR.url });
  assert(body.includes("Pull request opened: #101"), "names the PR number");
  assert(body.includes(PR.url), "links the PR URL");
});

// ── Gating ────────────────────────────────────────────────────────────────────

test("an epic slice (claimIssue not true) posts NOTHING and touches no state", async () => {
  const gh = stubGithubComments([]);
  const { data, claimAttempts } = fakeData({ feature_key: RUN.featureKey });
  try {
    const out = await ensureIssuePrLinkComment({ ...RUN, pr: PR, claimIssue: undefined }, data);
    assertEquals(out, "skipped");
    assertEquals(gh.posted.length, 0, "no comment was posted");
    assertEquals(claimAttempts, 0, "no claim was attempted");
  } finally {
    gh.restore();
  }
});

test("a blocked/skipped outcome (no PR) posts nothing", async () => {
  const gh = stubGithubComments([]);
  const { data, claimAttempts } = fakeData({ feature_key: RUN.featureKey });
  try {
    const out = await ensureIssuePrLinkComment({ ...RUN, pr: null, claimIssue: true }, data);
    assertEquals(out, "skipped");
    assertEquals(gh.posted.length, 0);
    assertEquals(claimAttempts, 0);
  } finally {
    gh.restore();
  }
});

// ── First run: posts exactly once ─────────────────────────────────────────────

test("first delivery: claims, finds no marker, and posts the PR-opened comment", async () => {
  const gh = stubGithubComments([]);
  const row: FeatureRowDouble = { feature_key: RUN.featureKey };
  const { data } = fakeData(row);
  try {
    const out = await ensureIssuePrLinkComment({ ...RUN, pr: PR, claimIssue: true }, data);
    assertEquals(out, "posted");
    assertEquals(gh.posted.length, 1, "exactly one comment was posted");
    assertEquals(gh.posted[0].body, prOpenedCommentBody({ number: 101, title: null, url: PR.url }));
    assertEquals(row.pr_linked_pr_key, PR.prKey, "the durable link record was claimed");
  } finally {
    gh.restore();
  }
});

// ── Idempotence ───────────────────────────────────────────────────────────────

test("a repeated pass with the SAME pr already recorded is a no-op (no GitHub read, no post)", async () => {
  const gh = stubGithubComments([], { failList: true, failPost: true });
  const { data, claimAttempts } = fakeData({
    feature_key: RUN.featureKey,
    pr_linked_pr_key: PR.prKey,
  });
  try {
    const out = await ensureIssuePrLinkComment({ ...RUN, pr: PR, claimIssue: true }, data);
    assertEquals(out, "already-recorded");
    assertEquals(claimAttempts, 0, "no claim was attempted");
    assertEquals(gh.posted.length, 0, "no comment was posted");
  } finally {
    gh.restore();
  }
});

test("a lost claim (comment posted, record never persisted) is healed by the marker scan — no double post", async () => {
  // The marker for THIS PR is already on the issue (a previous pass posted it and then crashed
  // before its claim landed): the scan sees it and records the claim WITHOUT re-posting.
  const gh = stubGithubComments([{ body: `🤖 Pull request opened: #101\n\n${ISSUE_PR_LINK_MARKER_PREFIX}101 -->` }]);
  const row: FeatureRowDouble = { feature_key: RUN.featureKey };
  const { data } = fakeData(row);
  try {
    const out = await ensureIssuePrLinkComment({ ...RUN, pr: PR, claimIssue: true }, data);
    assertEquals(out, "already-marked");
    assertEquals(gh.posted.length, 0, "the marker suppressed a duplicate comment");
    assertEquals(row.pr_linked_pr_key, PR.prKey, "the healed claim was persisted");
  } finally {
    gh.restore();
  }
});

test("a concurrent claim loser (CAS changed=0) does NOT post — the winner's pass owns the comment", async () => {
  const gh = stubGithubComments([]);
  const { data } = fakeData({ feature_key: RUN.featureKey }, { claimSucceeds: false });
  try {
    const out = await ensureIssuePrLinkComment({ ...RUN, pr: PR, claimIssue: true }, data);
    assertEquals(out, "claim-lost");
    assertEquals(gh.posted.length, 0, "no comment was posted by the losing pass");
  } finally {
    gh.restore();
  }
});

// ── Best-effort: failures never throw ─────────────────────────────────────────

test("a failed comment POST releases the claim (a later pass retries) and never throws", async () => {
  const gh = stubGithubComments([], { failPost: true });
  const row: FeatureRowDouble = { feature_key: RUN.featureKey };
  const { data } = fakeData(row);
  try {
    const out = await ensureIssuePrLinkComment({ ...RUN, pr: PR, claimIssue: true }, data);
    assertEquals(out, "post-failed");
    assertEquals(row.pr_linked_pr_key, null, "the failed claim was released so a later pass retries");
  } finally {
    gh.restore();
  }
});

test("a failed comment LISTING keeps the claim (the marker scan is the safety net) and never throws", async () => {
  const gh = stubGithubComments([], { failList: true });
  const row: FeatureRowDouble = { feature_key: RUN.featureKey };
  const { data } = fakeData(row);
  try {
    const out = await ensureIssuePrLinkComment({ ...RUN, pr: PR, claimIssue: true }, data);
    assertEquals(out, "list-failed");
    assertEquals(row.pr_linked_pr_key, PR.prKey, "the claim stands — the marker scan heals a double-post risk");
    assertEquals(gh.posted.length, 0, "no comment was posted blind");
  } finally {
    gh.restore();
  }
});

test("a missing feature_runs row (or a thrown claim) is a guarded no-op", async () => {
  const gh = stubGithubComments([]);
  const noRow = fakeData(null);
  try {
    assertEquals(await ensureIssuePrLinkComment({ ...RUN, pr: PR, claimIssue: true }, noRow.data), "skipped");
    const throwing = fakeData({ feature_key: RUN.featureKey }, { claimThrows: true });
    assertEquals(await ensureIssuePrLinkComment({ ...RUN, pr: PR, claimIssue: true }, throwing.data), "skipped");
    assertEquals(gh.posted.length, 0, "nothing was posted");
  } finally {
    gh.restore();
  }
});

// ── A PR CHANGE re-links (a superseded PR is re-announced exactly once) ───────

test("a DIFFERENT PR than the recorded one is announced again (the delivered PR changed)", async () => {
  const gh = stubGithubComments([]);
  const row: FeatureRowDouble = { feature_key: RUN.featureKey, pr_linked_pr_key: "owner/repo#99" };
  const { data } = fakeData(row);
  try {
    const out = await ensureIssuePrLinkComment(
      { ...RUN, pr: { prKey: "owner/repo#102", number: 102, url: "https://github.com/owner/repo/pull/102" }, claimIssue: true },
      data,
    );
    assertEquals(out, "posted");
    assertEquals(gh.posted.length, 1, "the replacement PR was announced");
    assert(gh.posted[0].body.includes("#102"), "the comment names the NEW PR");
    assertEquals(row.pr_linked_pr_key, "owner/repo#102", "the link record advanced to the new PR");
  } finally {
    gh.restore();
  }
});
