// Unit coverage for the canonical "PR opened" issue-link decision (issue #907).
//
// When a single-issue feature run delivers its PR, the HOST posts one idempotent
// `🤖 Pull request opened: #n — …` comment on the claimed issue, so the issue thread links to the
// delivered PR even when the agent (or a retry, or the reconcile-adopt path) opened it without
// saying so. This module is the ONE writer (derivation over duplication): `pr.record-feature`
// records the owed link and attempts it once on the delivery point; the poller's
// `retryOutstandingIssuePrLinks` pass re-attempts every outstanding link.
//
// The durable state machine (migration 125) is pinned here:
//   • `pr_link_want_pr_key` — the owed PR (written by `requestIssuePrLink`),
//   • `pr_linked_pr_key`    — the CONFIRMED link (written only after a successful POST or a marker
//     match — a pending lease is NEVER mistaken for a confirmed link), and
//   • `pr_link_lease_at`    — an EXPIRING in-flight lease, CAS-claimed before any GitHub I/O so two
//     racing passes never both post; a failure leaves it to expire (the retry backoff),
// plus the hidden `<!-- nwf:pr-linked:#n -->` marker scan over ALL pages of the issue's comments,
// which heals a crash between a successful POST and the confirm write.
//
// The GitHub reads/writes are hermetically stubbed via the pinned `token` transport + a fetch
// double (mirrors workers/reconcile-implement/worker.test.ts) — no `gh` subprocess, no network.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import {
  attemptIssuePrLink,
  ISSUE_PR_LINK_LEASE_MS,
  ISSUE_PR_LINK_MARKER_PREFIX,
  prOpenedCommentBody,
  requestIssuePrLink,
  retryOutstandingIssuePrLinks,
} from "./issuePrLink.ts";

// ── Fetch stub ────────────────────────────────────────────────────────────────

interface PostedComment {
  body: string;
}

/** A hermetic GitHub API double: serves the seeded comment bodies on GET …/issues/{n}/comments
 *  (paginated — `pages` maps a 1-based page to that page's bodies, defaulting to one page holding
 *  `existing`), serves a PR title on GET …/pulls/{n}, and records comment POSTs (optionally failing
 *  them, or THROWING to simulate a connection failure). Records the URL path of every call. */
function stubGithub(
  existing: { body: string }[],
  opts: {
    failList?: boolean;
    failPost?: boolean;
    throwPost?: boolean;
    pages?: Record<number, { body: string }[]>;
    prTitles?: Record<string, string>;
  } = {},
): { posted: PostedComment[]; calls: string[]; restore: () => void } {
  const prevTransport = process.env.NANO_PR_GITHUB_TRANSPORT;
  const prevToken = process.env.GITHUB_TOKEN;
  const prevFetch = globalThis.fetch;
  process.env.NANO_PR_GITHUB_TRANSPORT = "token";
  process.env.GITHUB_TOKEN = "t";
  const posted: PostedComment[] = [];
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const u = new URL(String(url));
    calls.push(`${method} ${u.pathname}${u.search}`);
    if (method === "GET" && /\/issues\/\d+\/comments$/.test(u.pathname)) {
      if (opts.failList) return new Response("boom", { status: 500 });
      const page = Number(u.searchParams.get("page") ?? "1");
      const bodies = opts.pages ? (opts.pages[page] ?? []) : page === 1 ? existing : [];
      return new Response(JSON.stringify(bodies), { status: 200 });
    }
    if (method === "GET" && /\/pulls\/\d+$/.test(u.pathname)) {
      const title = opts.prTitles?.[u.pathname] ?? "the PR";
      return new Response(JSON.stringify({ title }), { status: 200 });
    }
    if (method === "POST" && /\/issues\/\d+\/comments$/.test(u.pathname)) {
      if (opts.throwPost) throw new TypeError("fetch failed: connection reset");
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
    calls,
    restore: () => {
      globalThis.fetch = prevFetch;
      if (prevTransport === undefined) delete process.env.NANO_PR_GITHUB_TRANSPORT;
      else process.env.NANO_PR_GITHUB_TRANSPORT = prevTransport;
      if (prevToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prevToken;
    },
  };
}

// ── DB double (feature_runs row + the three state-machine columns) ────────────

interface FeatureRowDouble {
  feature_key: string;
  repo?: string;
  issue_number?: number;
  pr_link_want_pr_key?: string | null;
  pr_linked_pr_key?: string | null;
  pr_link_lease_at?: string | null;
}

/** The minimal DataLayer double the link step touches: `table("feature_runs").get` plus the
 *  `open().exec`/`open().query` SQL the state machine runs. The execs are applied to the in-memory
 *  row(s) with the same guards the real CAS carries, so the tests observe exactly what SQLite
 *  would do. `claimSucceeds: false` forces the lease CAS to report changed=0 (a live lease held by
 *  another pass); `claimThrows` simulates a DB failure. */
function fakeData(
  seedRows: FeatureRowDouble[],
  opts: { claimSucceeds?: boolean; claimThrows?: boolean; scanThrows?: boolean } = {},
): { data: never; rows: FeatureRowDouble[]; leaseAttempts: number } {
  const rows = seedRows;
  let leaseAttempts = 0;
  const data = {
    table: (name: string, _key: string) => {
      assertEquals(name, "feature_runs");
      return {
        get: (k: string) => Promise.resolve(rows.find((r) => r.feature_key === k) ?? null),
      };
    },
    open: () => ({
      exec: (sql: string, params: unknown[]) => {
        if (opts.claimThrows) throw new Error("db down");
        // requestIssuePrLink's "owed" write: SET pr_link_want_pr_key = ? WHERE feature_key = ?
        if (/UPDATE "feature_runs" SET "pr_link_want_pr_key" = \?/.test(sql)) {
          const row = rows.find((r) => r.feature_key === params[1]);
          if (!row) return { changed: 0 };
          row.pr_link_want_pr_key = String(params[0]);
          return { changed: 1 };
        }
        // The lease CAS: SET pr_link_lease_at = ? WHERE feature_key = ? AND want = ? AND
        // (linked IS NULL OR linked != want) AND (lease IS NULL OR lease < expired). The
        // `claimSucceeds: false` double simulates a lost race by RE-ARMING the row with a fresh
        // live lease and reporting changed=0 (what a concurrent winner's claim looks like).
        if (/UPDATE "feature_runs" SET "pr_link_lease_at" = \?/.test(sql)) {
          leaseAttempts += 1;
          const [ts, featureKey, want, want2, expired] = params.map(String);
          assertEquals(want, want2, "the CAS guards the owed key against both params");
          const row = rows.find((r) => r.feature_key === featureKey);
          const guarded =
            row &&
            row.pr_link_want_pr_key === want &&
            (row.pr_linked_pr_key == null || row.pr_linked_pr_key !== want) &&
            (row.pr_link_lease_at == null || row.pr_link_lease_at < expired);
          if (opts.claimSucceeds === false) {
            if (row) row.pr_link_lease_at = ts; // the "other pass" now holds a live lease
            return { changed: 0 };
          }
          const changed = guarded ? 1 : 0;
          if (changed > 0 && row) row.pr_link_lease_at = ts;
          return { changed };
        }
        // The confirm: SET pr_linked_pr_key = ?, pr_link_lease_at = NULL WHERE feature_key = ?
        // AND pr_link_lease_at = ? (only the lease holder confirms).
        if (/UPDATE "feature_runs" SET "pr_linked_pr_key" = \?, "pr_link_lease_at" = NULL/.test(sql)) {
          const [want, featureKey, lease] = params.map(String);
          const row = rows.find((r) => r.feature_key === featureKey && r.pr_link_lease_at === lease);
          if (!row) return { changed: 0 };
          row.pr_linked_pr_key = want;
          row.pr_link_lease_at = null;
          return { changed: 1 };
        }
        throw new Error(`unexpected SQL in test double: ${sql}`);
      },
      query: (sql: string, params: unknown[]) => {
        if (opts.scanThrows) throw new Error("db down");
        assert(
          /FROM "feature_runs" WHERE "pr_link_want_pr_key" IS NOT NULL/.test(sql),
          `the retry pass scans only owed rows (got: ${sql})`,
        );
        const expired = String(params[0]);
        return Promise.resolve(
          rows
            .filter(
              (r) =>
                r.pr_link_want_pr_key != null &&
                (r.pr_linked_pr_key == null || r.pr_linked_pr_key !== r.pr_link_want_pr_key) &&
                (r.pr_link_lease_at == null || r.pr_link_lease_at < expired),
            )
            .map((r) => ({ feature_key: r.feature_key })),
        );
      },
    }),
  };
  return {
    data: data as never,
    rows,
    get leaseAttempts() {
      return leaseAttempts;
    },
  };
}

const KEY = "owner/repo#7"; // the feature run (claimed issue owner/repo#7)
const PR = "owner/repo#101"; // the delivered PR key
const PR_URL = "https://github.com/owner/repo/pull/101";

/** Seed a run row owed a link for PR (as requestIssuePrLink would have written). */
function owedRow(extra: Partial<FeatureRowDouble> = {}): FeatureRowDouble {
  return {
    feature_key: KEY,
    repo: "owner/repo",
    issue_number: 7,
    pr_link_want_pr_key: PR,
    pr_linked_pr_key: null,
    pr_link_lease_at: null,
    ...extra,
  };
}

// ── Comment body ──────────────────────────────────────────────────────────────

test("the comment body carries the PR number, title, URL and the hidden dedupe marker", () => {
  const body = prOpenedCommentBody({ number: 101, title: "Add the thing", url: PR_URL });
  assert(body.includes("Pull request opened: #101"), "names the PR number");
  assert(body.includes("Add the thing"), "names the PR title");
  assert(body.includes(PR_URL), "links the PR URL");
  assert(
    body.includes(`${ISSUE_PR_LINK_MARKER_PREFIX}101 -->`),
    "carries the hidden per-PR dedupe marker",
  );
});

test("the comment body tolerates a missing title", () => {
  const body = prOpenedCommentBody({ number: 101, title: null, url: PR_URL });
  assert(body.includes("Pull request opened: #101"), "names the PR number");
  assert(body.includes(PR_URL), "links the PR URL");
});

// ── Gating (requestIssuePrLink) ───────────────────────────────────────────────

test("an epic slice (claimIssue not true) posts NOTHING and touches no state", async () => {
  const gh = stubGithub([]);
  const { data, rows, leaseAttempts } = fakeData([{ feature_key: KEY, repo: "owner/repo", issue_number: 7 }]);
  try {
    const out = await requestIssuePrLink({ featureKey: KEY, prKey: PR, claimIssue: undefined }, data);
    assertEquals(out, "skipped");
    assertEquals(gh.posted.length, 0, "no comment was posted");
    assertEquals(leaseAttempts, 0, "no lease was attempted");
    assertEquals(rows[0].pr_link_want_pr_key, undefined, "no owed link was recorded");
  } finally {
    gh.restore();
  }
});

test("a blocked/skipped outcome (no PR) posts nothing and records no owed link", async () => {
  const gh = stubGithub([]);
  const { data, rows, leaseAttempts } = fakeData([{ feature_key: KEY, repo: "owner/repo", issue_number: 7 }]);
  try {
    const out = await requestIssuePrLink({ featureKey: KEY, prKey: null, claimIssue: true }, data);
    assertEquals(out, "skipped");
    assertEquals(gh.posted.length, 0);
    assertEquals(leaseAttempts, 0);
    assertEquals(rows[0].pr_link_want_pr_key, undefined, "no owed link was recorded");
  } finally {
    gh.restore();
  }
});

test("an unparseable PR key is a guarded no-op", async () => {
  const gh = stubGithub([]);
  const { data, rows } = fakeData([{ feature_key: KEY, repo: "owner/repo", issue_number: 7 }]);
  try {
    const out = await requestIssuePrLink({ featureKey: KEY, prKey: "not-a-pr-key", claimIssue: true }, data);
    assertEquals(out, "skipped");
    assertEquals(gh.posted.length, 0);
    assertEquals(rows[0].pr_link_want_pr_key, undefined);
  } finally {
    gh.restore();
  }
});

test("a missing feature_runs row records nothing and posts nothing", async () => {
  const gh = stubGithub([]);
  const { data } = fakeData([]);
  try {
    const out = await requestIssuePrLink({ featureKey: KEY, prKey: PR, claimIssue: true }, data);
    assertEquals(out, "skipped");
    assertEquals(gh.posted.length, 0);
  } finally {
    gh.restore();
  }
});

// ── First delivery: posts exactly once and confirms ───────────────────────────

test("first delivery: records the owed link, claims the lease, finds no marker, posts and confirms", async () => {
  const gh = stubGithub([]);
  const { data, rows } = fakeData([{ feature_key: KEY, repo: "owner/repo", issue_number: 7 }]);
  try {
    const out = await requestIssuePrLink({ featureKey: KEY, prKey: PR, claimIssue: true }, data);
    assertEquals(out, "posted");
    assertEquals(rows[0].pr_link_want_pr_key, PR, "the owed link was recorded");
    assertEquals(gh.posted.length, 1, "exactly one comment was posted");
    assertEquals(gh.posted[0].body, prOpenedCommentBody({ number: 101, title: "the PR", url: PR_URL }));
    assertEquals(rows[0].pr_linked_pr_key, PR, "the link was CONFIRMED only after the successful POST");
    assertEquals(rows[0].pr_link_lease_at, null, "the lease was released by the confirm");
  } finally {
    gh.restore();
  }
});

// ── Idempotence ───────────────────────────────────────────────────────────────

test("a repeated pass with the SAME pr already confirmed is a no-op (no GitHub read, no post)", async () => {
  const gh = stubGithub([], { failList: true, failPost: true });
  const { data, leaseAttempts } = fakeData([owedRow({ pr_linked_pr_key: PR })]);
  try {
    const out = await requestIssuePrLink({ featureKey: KEY, prKey: PR, claimIssue: true }, data);
    assertEquals(out, "already-recorded");
    assertEquals(leaseAttempts, 0, "no lease was attempted");
    assertEquals(gh.posted.length, 0, "no comment was posted");
    assertEquals(gh.calls.length, 0, "no GitHub I/O at all");
  } finally {
    gh.restore();
  }
});

test("a lost confirm (comment posted, confirm never persisted) is healed by the marker scan — no double post", async () => {
  // The marker for THIS PR is already on the issue (a previous pass posted it and then crashed
  // before its confirm landed): the scan sees it and confirms WITHOUT re-posting.
  const gh = stubGithub([{ body: `🤖 Pull request opened: #101\n\n${ISSUE_PR_LINK_MARKER_PREFIX}101 -->` }]);
  const { data, rows } = fakeData([owedRow()]);
  try {
    const out = await attemptIssuePrLink(KEY, data);
    assertEquals(out, "already-marked");
    assertEquals(gh.posted.length, 0, "the marker suppressed a duplicate comment");
    assertEquals(rows[0].pr_linked_pr_key, PR, "the healed link was confirmed");
    assertEquals(rows[0].pr_link_lease_at, null, "the lease was released");
  } finally {
    gh.restore();
  }
});

test("the marker scan paginates through EVERY page before deciding the marker is absent", async () => {
  // 100 bodies on page 1 (a full page) with the marker only on page 2: a first-page-only scan
  // would double-post; the paginated scan finds it and confirms without posting.
  const page1 = Array.from({ length: 100 }, (_, i) => ({ body: `comment ${i}` }));
  const page2 = [{ body: `🤖 Pull request opened: #101\n\n${ISSUE_PR_LINK_MARKER_PREFIX}101 -->` }];
  const gh = stubGithub([], { pages: { 1: page1, 2: page2 } });
  const { data, rows } = fakeData([owedRow()]);
  try {
    const out = await attemptIssuePrLink(KEY, data);
    assertEquals(out, "already-marked");
    assertEquals(gh.posted.length, 0, "the later-page marker suppressed a duplicate comment");
    assert(gh.calls.some((c) => c.includes("page=2")), "page 2 was scanned");
    assertEquals(rows[0].pr_linked_pr_key, PR, "the healed link was confirmed");
  } finally {
    gh.restore();
  }
});

test("a concurrent lease holder (CAS changed=0) does NOT post — the holder's pass owns the comment", async () => {
  const gh = stubGithub([]);
  const { data } = fakeData([owedRow()], { claimSucceeds: false });
  try {
    const out = await attemptIssuePrLink(KEY, data);
    assertEquals(out, "claim-lost");
    assertEquals(gh.posted.length, 0, "no comment was posted by the losing pass");
  } finally {
    gh.restore();
  }
});

test("a live (unexpired) lease blocks a second attempt — the CAS guard rejects it, no GitHub I/O", async () => {
  const gh = stubGithub([], { failList: true, failPost: true });
  const now = new Date("2026-01-01T00:10:00.000Z");
  const leaseAt = new Date(now.getTime() - 60_000).toISOString(); // 1 minute ago — well inside the lease
  const { data, rows } = fakeData([owedRow({ pr_link_lease_at: leaseAt })]);
  try {
    const out = await attemptIssuePrLink(KEY, data, "t", () => now);
    assertEquals(out, "claim-lost");
    assertEquals(rows[0].pr_link_lease_at, leaseAt, "the live lease was untouched (the CAS guard rejected the claim)");
    assertEquals(gh.calls.length, 0, "no GitHub I/O while another pass holds the lease");
  } finally {
    gh.restore();
  }
});

// ── Failure semantics: the lease is the backoff, the poller retries ───────────

test("a failed comment POST leaves the owed link UNCONFIRMED and the lease to expire — never throws", async () => {
  const gh = stubGithub([], { failPost: true });
  const { data, rows } = fakeData([owedRow()]);
  try {
    const out = await attemptIssuePrLink(KEY, data);
    assertEquals(out, "post-failed");
    assertEquals(rows[0].pr_linked_pr_key, null, "a failed POST is NEVER mistaken for a confirmed link");
    assert(rows[0].pr_link_lease_at != null, "the in-flight lease stands as the retry backoff");
  } finally {
    gh.restore();
  }
});

test("a THROWN comment POST (connection failure) is normalised to post-failed — the lease still expires for a retry", async () => {
  const gh = stubGithub([], { throwPost: true });
  const { data, rows } = fakeData([owedRow()]);
  try {
    const out = await attemptIssuePrLink(KEY, data);
    assertEquals(out, "post-failed");
    assertEquals(rows[0].pr_linked_pr_key, null, "a thrown POST never confirms the link");
    assert(rows[0].pr_link_lease_at != null, "the lease stands as the retry backoff");
  } finally {
    gh.restore();
  }
});

test("a failed comment LISTING posts nothing blind, confirms nothing, and leaves the lease to expire", async () => {
  const gh = stubGithub([], { failList: true });
  const { data, rows } = fakeData([owedRow()]);
  try {
    const out = await attemptIssuePrLink(KEY, data);
    assertEquals(out, "list-failed");
    assertEquals(gh.posted.length, 0, "no comment was posted blind");
    assertEquals(rows[0].pr_linked_pr_key, null, "an unreadable scan never confirms the link");
    assert(rows[0].pr_link_lease_at != null, "the lease stands as the retry backoff");
  } finally {
    gh.restore();
  }
});

test("a crashed attempt's EXPIRED lease is re-claimable — the poller retry posts and confirms", async () => {
  const gh = stubGithub([]);
  const now = new Date("2026-01-01T01:00:00.000Z");
  const staleLease = new Date(now.getTime() - ISSUE_PR_LINK_LEASE_MS - 1000).toISOString();
  const { data, rows } = fakeData([owedRow({ pr_link_lease_at: staleLease })]);
  try {
    const out = await attemptIssuePrLink(KEY, data, "t", () => now);
    assertEquals(out, "posted");
    assertEquals(gh.posted.length, 1, "the retry posted the comment");
    assertEquals(rows[0].pr_linked_pr_key, PR, "the retry confirmed the link");
    assertEquals(rows[0].pr_link_lease_at, null, "the lease was released by the confirm");
  } finally {
    gh.restore();
  }
});

test("a missing row, a row with nothing owed, or a thrown claim is a guarded no-op", async () => {
  const gh = stubGithub([]);
  const noRow = fakeData([]);
  const nothingOwed = fakeData([{ feature_key: KEY, repo: "owner/repo", issue_number: 7 }]);
  const throwing = fakeData([owedRow()], { claimThrows: true });
  try {
    assertEquals(await attemptIssuePrLink(KEY, noRow.data), "skipped");
    assertEquals(await attemptIssuePrLink(KEY, nothingOwed.data), "skipped");
    assertEquals(await attemptIssuePrLink(KEY, throwing.data), "skipped");
    assertEquals(gh.posted.length, 0, "nothing was posted");
  } finally {
    gh.restore();
  }
});

// ── Targeting: the comment goes to the CLAIMED ISSUE, the title to the PR's repo ──

test("a cross-repo PR comments on the CLAIMED issue (row repo + issue_number), not the PR's repo", async () => {
  const gh = stubGithub([], { prTitles: { "/repos/owner/code/pulls/101": "the cross-repo PR" } });
  const { data, rows } = fakeData([owedRow()]);
  try {
    const out = await requestIssuePrLink({ featureKey: KEY, prKey: "owner/code#101", claimIssue: true }, data);
    assertEquals(out, "posted");
    assertEquals(rows[0].pr_link_want_pr_key, "owner/code#101", "the owed link names the cross-repo PR");
    assert(
      gh.calls.some((c) => c.startsWith("POST /repos/owner/repo/issues/7/comments")),
      `the comment landed on the claimed issue owner/repo#7 (calls: ${gh.calls.join(", ")})`,
    );
    assert(
      gh.calls.some((c) => c.startsWith("GET /repos/owner/code/pulls/101")),
      "the title was read from the PR's OWN repository",
    );
    assert(!gh.calls.some((c) => c.includes("/repos/owner/code/issues/")), "the PR repo's issues were never touched");
    assert(gh.posted[0].body.includes("https://github.com/owner/code/pull/101"), "the comment links the cross-repo PR");
    assert(gh.posted[0].body.includes("the cross-repo PR"), "the comment carries the cross-repo title");
  } finally {
    gh.restore();
  }
});

// ── A PR CHANGE re-links (a superseded PR is re-announced exactly once) ───────

test("a DIFFERENT PR than the confirmed one is owed and announced again (the delivered PR changed)", async () => {
  const gh = stubGithub([]);
  const { data, rows } = fakeData([owedRow({ pr_link_want_pr_key: "owner/repo#99", pr_linked_pr_key: "owner/repo#99" })]);
  try {
    const out = await requestIssuePrLink({ featureKey: KEY, prKey: "owner/repo#102", claimIssue: true }, data);
    assertEquals(out, "posted");
    assertEquals(gh.posted.length, 1, "the replacement PR was announced");
    assert(gh.posted[0].body.includes("#102"), "the comment names the NEW PR");
    assertEquals(rows[0].pr_link_want_pr_key, "owner/repo#102", "the owed link advanced to the new PR");
    assertEquals(rows[0].pr_linked_pr_key, "owner/repo#102", "the confirmed link advanced to the new PR");
  } finally {
    gh.restore();
  }
});

// ── The poller retry pass ─────────────────────────────────────────────────────

test("the poller retries only OUTSTANDING owed links — confirmed, unowed, and live-lease rows are untouched", async () => {
  const gh = stubGithub([]);
  const now = new Date("2026-01-01T01:00:00.000Z");
  const liveLease = new Date(now.getTime() - 60_000).toISOString();
  const { data, rows } = fakeData([
    owedRow({ feature_key: "owner/repo#1" }), // outstanding, no lease → retried
    owedRow({ feature_key: "owner/repo#2", pr_linked_pr_key: PR }), // confirmed → skipped
    { feature_key: "owner/repo#3", repo: "owner/repo", issue_number: 3 }, // nothing owed → skipped
    owedRow({ feature_key: "owner/repo#4", pr_link_lease_at: liveLease }), // live lease → skipped
  ]);
  try {
    const out = await retryOutstandingIssuePrLinks(data, "t", () => now);
    assertEquals(out, { "owner/repo#1": "posted" }, "only the outstanding unleased row was attempted");
    assertEquals(gh.posted.length, 1, "exactly one comment was posted");
    assertEquals(rows[1].pr_link_lease_at, null, "the confirmed row was untouched");
    assertEquals(rows[3].pr_link_lease_at, liveLease, "the live lease was untouched");
  } finally {
    gh.restore();
  }
});

test("the poller retry heals a post-failed attempt once its lease expires", async () => {
  // First attempt: the POST fails → post-failed, unconfirmed, lease standing.
  const failing = stubGithub([], { failPost: true });
  const now = new Date("2026-01-01T01:00:00.000Z");
  const { data, rows } = fakeData([owedRow()]);
  try {
    assertEquals(await attemptIssuePrLink(KEY, data, "t", () => now), "post-failed");
    assertEquals(rows[0].pr_linked_pr_key, null);
  } finally {
    failing.restore();
  }
  // A later poll pass (after the lease expired): GitHub has recovered → the retry posts + confirms.
  const recovered = stubGithub([]);
  const later = new Date(now.getTime() + ISSUE_PR_LINK_LEASE_MS + 1000);
  try {
    const out = await retryOutstandingIssuePrLinks(data, "t", () => later);
    assertEquals(out, { [KEY]: "posted" }, "the retry pass re-attempted the outstanding link");
    assertEquals(recovered.posted.length, 1, "the retried comment landed");
    assertEquals(rows[0].pr_linked_pr_key, PR, "the retried link was confirmed");
  } finally {
    recovered.restore();
  }
});

test("the poller pass never throws — a DB failure resolves to an empty outcome map", async () => {
  const gh = stubGithub([]);
  const throwing = fakeData([owedRow()], { scanThrows: true });
  try {
    const out = await retryOutstandingIssuePrLinks(throwing.data);
    assertEquals(out, {}, "a thrown scan resolves to no outcomes");
    assertEquals(gh.posted.length, 0);
  } finally {
    gh.restore();
  }
});
