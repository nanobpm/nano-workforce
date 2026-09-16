// Behavioral regression for the poller's stale-review branch (#799, FM2).
//
// `pollReviews` must only resume the convergence loop on a review of the CURRENT head. When the PR
// HEAD has advanced past the commit the newest review was submitted against, that review is STALE:
// its advisories describe code the head already moved past. Publishing `readiness-ready` on it would
// resume the loop on obsolete findings and re-escalate a human on an already-fixed advisory. The
// poller must instead treat a stale review like "no fresh review" — (re-)solicit and wait — WITHOUT
// advancing `last_review_id` or emitting the readiness signal.
//
// The pure `isReviewStale` predicate and the injected converge-gate already have coverage; this
// test locks the poller's own STATE TRANSITION (which those cannot), driving the real token-mode
// transport with a stubbed `fetch` so a differing branch-head SHA vs review `commit_id` is exercised
// end-to-end. A control with a CURRENT-head review asserts the loop still resumes.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { withTrackingViews } from "../test/trackingViews.ts";
import { READINESS_READY_MESSAGE } from "./readiness.ts";
import { pollReviews } from "./service.ts";

function memTable(rows: any[], key: string) {
  return {
    get: (k: any) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
    all: () => Promise.resolve([...rows]),
    find: (q: any) =>
      Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
    findOne: (q: any) =>
      Promise.resolve(rows.find((r) => Object.entries(q).every(([f, v]) => r[f] === v)) ?? null),
    insert: (r: any) => {
      rows.push(r);
      return Promise.resolve(r);
    },
    update: (k: any, patch: any) => {
      const r = rows.find((x) => x[key] === k);
      if (r) Object.assign(r, patch);
      return Promise.resolve(r);
    },
    delete: (k: any) => {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i][key] === k) rows.splice(i, 1);
      return Promise.resolve();
    },
  };
}

const REPO = "owner/repo";
const NUMBER = 7;
const HEAD_REF = "feat/x";

/** Stub the token transport for exactly the endpoints the stale-review branch reads:
 *  - the paged reviews list (one short page → complete),
 *  - the PR object (for the head ref/repo),
 *  - the atomic branch ref (`git/ref/heads/<branch>`) the shared reader prefers, and
 *  - the requested-reviewers GET/POST the re-solicitation nudge uses.
 * `branchHead` drives staleness: when it differs from the review's `commit_id` the review is stale.
 * Every non-GET request is recorded in `posts` so a test can assert the nudge's reviewer-request POST
 * actually fired (a regression that dropped the stale branch's nudge would leave `posts` empty). */
function reviewFetch(opts: { reviewCommitId: string; branchHead: string; posts: string[] }) {
  return (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (body: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
      );
    if (u.includes(`/pulls/${NUMBER}/requested_reviewers`)) {
      if (method !== "GET") {
        opts.posts.push(`${method} ${u}`);
        return json({}, 201); // reviewer requested
      }
      return json({ users: [] }); // none pending → the nudge proceeds to the POST
    }
    if (u.includes(`/pulls/${NUMBER}/reviews`)) {
      return json([
        { id: 5, state: "COMMENTED", submitted_at: "2026-09-16T00:45:33Z", commit_id: opts.reviewCommitId },
      ]);
    }
    if (u.includes(`/git/ref/heads/${HEAD_REF}`)) {
      return json({ object: { sha: opts.branchHead } });
    }
    if (u.endsWith(`/pulls/${NUMBER}`)) {
      return json({ head: { ref: HEAD_REF, sha: opts.branchHead, repo: { full_name: REPO } }, base: { ref: "main" } });
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  };
}

function makeEngine() {
  const published: Array<{ name: string; correlationKey: string }> = [];
  const engine = {
    publishMessage: (m: { name: string; correlationKey: string }) => {
      published.push({ name: m.name, correlationKey: m.correlationKey });
      return Promise.resolve();
    },
  } as any;
  return { engine, published };
}

function withTokenTransport<T>(run: () => Promise<T>): Promise<T> {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevTok = process.env["GITHUB_TOKEN"];
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  process.env["GITHUB_TOKEN"] = "test-token";
  return run().finally(() => {
    if (prevMode !== undefined) process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
    else delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    if (prevTok !== undefined) process.env["GITHUB_TOKEN"] = prevTok;
    else delete process.env["GITHUB_TOKEN"];
  });
}

function prRow() {
  return {
    pr_key: `${REPO}#${NUMBER}`,
    repo: REPO,
    number: NUMBER,
    status: "waiting_review",
    last_review_id: 0,
    waiting_since: "2026-09-16T00:00:00Z",
    // An EXPIRED nudge timestamp so `maybeRerequestReview` does NOT short-circuit at its cooldown —
    // the stale branch must actually re-solicit a fresh review, and the test asserts that POST fired
    // (a recent nudge would mask a regression that dropped the nudge entirely, #799 review).
    last_nudge_at: "2000-01-01T00:00:00Z",
    updated_at: "t0",
  };
}

test("pollReviews: a STALE review (branch head past the review's commit) nudges but does NOT resume the loop", async () => {
  const row = prRow();
  const stores: Record<string, { rows: unknown[]; key: string }> = {
    pull_requests: { rows: [row], key: "pr_key" },
  };
  const data = {
    table: withTrackingViews((name: string, key: string) =>
      memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
    ),
  } as any;
  const { engine, published } = makeEngine();
  const posts: string[] = [];
  const prevFetch = globalThis.fetch;
  await withTokenTransport(async () => {
    // review was submitted against SHA_OLD, but the branch head has advanced to SHA_NEW → stale.
    globalThis.fetch = reviewFetch({ reviewCommitId: "SHA_OLD", branchHead: "SHA_NEW", posts }) as typeof fetch;
    try {
      await pollReviews(data, engine, "test-token");
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
  assertEquals(published.length, 0, "no readiness-ready signal is published for a stale review");
  assertEquals(row.last_review_id, 0, "last_review_id is NOT advanced past the stale review");
  assertEquals(row.status, "waiting_review", "the PR stays parked awaiting a fresh review");
  assertEquals(posts.length, 1, "the stale branch re-solicits a fresh Copilot review (one nudge POST)");
  assertEquals(
    posts[0],
    `POST https://api.github.com/repos/${REPO}/pulls/${NUMBER}/requested_reviewers`,
    "the nudge POSTs the requested-reviewers endpoint",
  );
});

test("pollReviews: a CURRENT-head review (control) resumes the loop and publishes the readiness signal", async () => {
  const row = prRow();
  const stores: Record<string, { rows: unknown[]; key: string }> = {
    pull_requests: { rows: [row], key: "pr_key" },
  };
  const data = {
    table: withTrackingViews((name: string, key: string) =>
      memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
    ),
  } as any;
  const { engine, published } = makeEngine();
  const posts: string[] = [];
  const prevFetch = globalThis.fetch;
  await withTokenTransport(async () => {
    // review's commit_id equals the current branch head → NOT stale.
    globalThis.fetch = reviewFetch({ reviewCommitId: "SHA_NEW", branchHead: "SHA_NEW", posts }) as typeof fetch;
    try {
      await pollReviews(data, engine, "test-token");
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
  assertEquals(published.length, 1, "the readiness-ready signal is published for a fresh review");
  assertEquals(published[0]?.name, READINESS_READY_MESSAGE);
  assertEquals(published[0]?.correlationKey, `${REPO}#${NUMBER}`);
  assertEquals(row.last_review_id, 5, "last_review_id advances to the fresh review");
  assertEquals(row.status, "converging", "the loop resumes (status flips to converging)");
  assertEquals(posts.length, 0, "a current-head review resumes directly — no re-solicitation nudge");
});
