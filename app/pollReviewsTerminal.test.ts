// Regression for issue #927 §3 (nano-bpm#1467): after the PR merged, the convergence loop kept
// re-requesting Copilot reviews on the MERGED PR for six rounds and finally escalated a review
// timeout. `pollReviews` must check the PR's live state before re-soliciting: a merged/closed PR
// retires the parked convergence instance and closes the row out — no reviewer-request POST.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { withTrackingViews } from "../test/trackingViews.ts";
import { pollReviews } from "./service.ts";

const REPO = "owner/repo";
const NUMBER = 9;

function memTable(rows: any[], key: string, lookups: unknown[] = []) {
  return {
    get: (k: any) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
    all: () => Promise.resolve([...rows]),
    find: (q: any) => Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
    findOne: (q: any) => {
      lookups.push(q);
      return Promise.resolve(rows.find((r) => Object.entries(q).every(([f, v]) => r[f] === v)) ?? null);
    },
    insert: (r: any) => {
      rows.push(r);
      return Promise.resolve(r);
    },
    update: (k: any, patch: any) => {
      const r = rows.find((x) => x[key] === k);
      if (r) Object.assign(r, patch);
      return Promise.resolve(r);
    },
    delete: () => Promise.resolve(),
  };
}

type Opts = { reviewsFail?: boolean; reviews?: unknown[]; cancelFails?: boolean; searchState?: string | null };

async function run(prState: { merged: boolean; state: string }, opts: Opts = {}) {
  const row: any = {
    pr_key: `${REPO}#${NUMBER}`,
    repo: REPO,
    number: NUMBER,
    status: "waiting_review",
    last_review_id: 0,
    waiting_since: "2026-11-08T15:08:58Z",
    last_nudge_at: "2000-01-01T00:00:00Z",
    process_key: "589000",
    updated_at: "t0",
  };
  const planLookups: unknown[] = [];
  const stores: Record<string, { rows: unknown[]; key: string }> = {
    pull_requests: { rows: [row], key: "pr_key" },
    merges: { rows: [], key: "id" },
    plan_tasks: { rows: [], key: "id" },
  };
  const data = {
    table: withTrackingViews((name: string, key: string) => {
      stores[name] ??= { rows: [], key };
      return memTable(stores[name].rows, stores[name].key, name === "plan_tasks" ? planLookups : []);
    }),
  } as any;
  const cancelled: string[] = [];
  const published: string[] = [];
  const engine = {
    publishMessage: (m: { name: string }) => {
      published.push(m.name);
      return Promise.resolve();
    },
    cancelInstance: (a: { processInstanceKey: string }) => {
      if (opts.cancelFails) return Promise.reject(new Error("transient engine error"));
      cancelled.push(a.processInstanceKey);
      return Promise.resolve();
    },
    searchProcessInstances: () =>
      Promise.resolve(
        opts.searchState === null ? [] : [{ processInstanceKey: "589000", state: opts.searchState ?? "ACTIVE" }],
      ),
  } as any;
  const posts: string[] = [];
  const prevFetch = globalThis.fetch;
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevTok = process.env["GITHUB_TOKEN"];
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  process.env["GITHUB_TOKEN"] = "test-token";
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (b: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status }));
    if (method !== "GET") posts.push(`${method} ${u}`);
    if (u.includes(`/pulls/${NUMBER}/requested_reviewers`)) return method === "GET" ? json({ users: [] }) : json({}, 201);
    if (u.includes(`/pulls/${NUMBER}/reviews`) && opts.reviewsFail) return json({ message: "bad gateway" }, 502);
    if (u.includes(`/pulls/${NUMBER}/reviews`)) return json(opts.reviews ?? []); // default: review requested, none arrived
    if (u.includes("/git/ref")) return json({ object: { sha: "e597b399" } });
    if (u.endsWith(`/pulls/${NUMBER}`)) return json({ ...prState, mergeable_state: "clean", head: { sha: "e597b399" } });
    return json({}, 404);
  }) as typeof fetch;
  try {
    await pollReviews(data, engine, "test-token");
  } finally {
    globalThis.fetch = prevFetch;
    if (prevMode !== undefined) process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
    else delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    if (prevTok !== undefined) process.env["GITHUB_TOKEN"] = prevTok;
    else delete process.env["GITHUB_TOKEN"];
  }
  return { row, posts, cancelled, published, stores, planLookups };
}

test("pollReviews #927: a PR MERGED while awaiting review retires the loop — no review re-request", async () => {
  const { row, posts, cancelled, published } = await run({ merged: true, state: "closed" });
  assertEquals(posts.length, 0, "no reviewer-request POST on a merged PR");
  assertEquals(cancelled, ["589000"], "the parked convergence instance is retired");
  assertEquals(published.length, 0);
  assertEquals(row.status, "merged");
  assertEquals(typeof row.merged_at, "string");
});

test("pollReviews #927: a PR CLOSED unmerged while awaiting review is abandoned — no review re-request", async () => {
  const { row, posts, cancelled, stores } = await run({ merged: false, state: "closed" });
  assertEquals(posts.length, 0);
  assertEquals(cancelled, ["589000"]);
  assertEquals((stores.merges.rows as any[]).some((m) => m.method === "pr-closed"), true);
  assertEquals(row.status === "waiting_review", false);
});

test("pollReviews #927: an OPEN PR awaiting review is still re-solicited (control)", async () => {
  const { row, posts, cancelled } = await run({ merged: false, state: "open" });
  assertEquals(cancelled.length, 0);
  assertEquals(row.status, "waiting_review");
  assertEquals(posts.length, 1, "the review nudge still fires for a live PR");
});

const HEAD_CURRENT_REVIEW = [
  { id: 77, state: "COMMENTED", submitted_at: "2026-11-08T16:00:00Z", commit_id: "e597b399", user: { login: "copilot-pull-request-reviewer[bot]" } },
];

for (const [label, prState] of [
  ["MERGED", { merged: true, state: "closed" }],
  ["CLOSED", { merged: false, state: "closed" }],
] as const) {
  test(`pollReviews #927: a HEAD-CURRENT review on a ${label} PR retires the loop — never resumes a round`, async () => {
    const { row, posts, cancelled, published } = await run(prState, { reviews: HEAD_CURRENT_REVIEW });
    assertEquals(published.length, 0, "no readiness-ready published for a terminal PR");
    assertEquals(posts.length, 0);
    assertEquals(cancelled, ["589000"]);
    assertEquals(row.status === "waiting_review" || row.status === "converging", false);
  });
}

test("pollReviews #927: a failed cancel of a still-LIVE instance leaves the row pollable", async () => {
  const { row, posts, published } = await run({ merged: true, state: "closed" }, { cancelFails: true, searchState: "ACTIVE" });
  assertEquals(row.status, "waiting_review", "not finalized while the instance (and its timer) lives");
  assertEquals(posts.length, 0, "no re-solicit this pass");
  assertEquals(published.length, 0);
});

for (const searchState of ["COMPLETED", null] as const) {
  test(`pollReviews #927: a failed cancel of an already-${searchState ?? "gone"} instance still finalizes`, async () => {
    const { row } = await run({ merged: true, state: "closed" }, { cancelFails: true, searchState });
    assertEquals(row.status, "merged");
  });
}

test("pollReviews #927: a PR merged externally while awaiting review runs the retro hook", async () => {
  // maybeStartRetro resolves the PR's plan via `plan_tasks`; the lookup proves the hook ran.
  const { planLookups } = await run({ merged: true, state: "closed" });
  assertEquals(planLookups, [{ pr_key: `${REPO}#${NUMBER}` }]);
});

test("pollReviews #927: a MERGED PR whose review fetch FAILS is still retired (terminal check precedes fetch)", async () => {
  const { row, posts, cancelled, published } = await run({ merged: true, state: "closed" }, { reviewsFail: true });
  assertEquals(cancelled, ["589000"]);
  assertEquals(published.length, 0);
  assertEquals(posts.length, 0);
  assertEquals(row.status, "merged");
});
