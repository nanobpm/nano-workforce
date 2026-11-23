// Issue #1043: approve → force-push → the merge stage must REQUEST a head-current review (once per
// head, review-only — never via merge-ready, so no landing gate is bypassed) instead of waiting forever in `wait-mergeable` for a
// review nothing ever asks for. Poller-level: drive `pollMerges` over a `waiting_merge` row whose
// latest Copilot review is on an OLD head while GitHub still reports the PR as not yet mergeable
// (the `waiting` verdict that used to `continue` silently every pass).
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import { memStatusCas } from "../test/memStatusCas.ts";
import { reviewWaitReason } from "./reviewWait.ts";
import { ensureHeadReviewRequested, POLLER_REVIEW_START_WINDOW_MS, pollMerges } from "./service.ts";

function memData(): { data: DataLayer; stores: Record<string, any[]> } {
  const stores: Record<string, any[]> = {};
  function tbl(name: string, pk = "id") {
    const rows = (stores[name] ??= [] as any[]);
    const match = (r: any, where: any) => Object.entries(where).every(([k, v]) => r[k] === v);
    return {
      async all() {
        return rows.slice();
      },
      async get(id: any) {
        return rows.find((r) => r[pk] === id);
      },
      async find(where: any = {}) {
        return rows.filter((r) => match(r, where));
      },
      async insert(row: any) {
        if (pk === "id" && row.id === undefined) row = { ...row, id: rows.length + 1 };
        rows.push({ ...row });
        return row[pk];
      },
      async update(id: any, patch: any) {
        const r = rows.find((row) => row[pk] === id);
        if (r) Object.assign(r, patch);
      },
      async delete(id: any) {
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i][pk] === id) rows.splice(i, 1);
      },
    };
  }
  const data = {
    table: (n: string, pk?: string) => tbl(n, pk),
    open: () => ({
      exec: async (sql: string, params: any[] = []) => {
        const cas = memStatusCas(stores, sql, params);
        if (cas) return cas;
        throw new Error(`memData.open().exec: unsupported statement: ${sql}`);
      },
    }),
  } as any as DataLayer;
  return { data, stores };
}

const OLD_HEAD = "8a65a9a5000000000000000000000000000000aa";
const NEW_HEAD = "39f5f15e000000000000000000000000000000bb";

/** Token-transport stub: PR view (`blocked` → `waiting` in token mode), Copilot reviews list. */
function githubFetch(fx: {
  reviewCommit: string | null;
  head: string;
  reviewsStatus?: number;
  pendingCopilot?: boolean;
  posts?: string[];
  deletes?: string[];
  timeline?: { event: string; created_at: string }[];
}) {
  return (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const json = (obj: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } }));
    if (u.pathname === "/graphql") {
      return json({
        data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } },
      });
    }
    if (/\/pulls\/\d+\/requested_reviewers$/.test(u.pathname)) {
      if (init?.method === "POST") {
        fx.posts?.push(u.pathname);
        return json({});
      }
      if (init?.method === "DELETE") {
        fx.deletes?.push(u.pathname);
        return json({});
      }
      return json({ users: fx.pendingCopilot ? [{ login: "Copilot" }] : [] });
    }
    if (/\/issues\/\d+\/timeline$/.test(u.pathname)) return json(fx.timeline ?? []);
    if (/\/pulls\/\d+\/reviews$/.test(u.pathname)) {
      if (fx.reviewsStatus) return json({}, fx.reviewsStatus);
      return json(
        fx.reviewCommit === null
          ? []
          : [{ id: 1, user: { login: "copilot-pull-request-reviewer[bot]" }, body: "Approval recommended", commit_id: fx.reviewCommit, state: "COMMENTED" }],
      );
    }
    if (/\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(u.pathname)) {
      return json({ merged: false, merged_at: null, state: "open", mergeable_state: "blocked", draft: false, head: { sha: fx.head }, base: { ref: "main" } });
    }
    return Promise.resolve(new Response(`unexpected ${u.pathname}`, { status: 500 }));
  };
}

async function withGithub<T>(fx: Parameters<typeof githubFetch>[0], fn: () => Promise<T>): Promise<T> {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevFetch = globalThis.fetch;
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  globalThis.fetch = githubFetch(fx) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prevFetch;
    if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
  }
}

function setup() {
  const { data, stores } = memData();
  const messages: any[] = [];
  const engine = { async publishMessage(m: any) { messages.push(m); } } as any as EngineClient;
  const ts = "2026-11-23T16:00:00Z";
  stores["pull_requests"] = [{
    pr_key: "o/r#1856", repo: "o/r", number: 1856, url: "https://github.com/o/r/pull/1856", title: "t",
    status: "waiting_merge", current_round: 0, process_key: "merge-live-1", waiting_since: null,
    last_review_id: null, outcome: null, created_at: ts, updated_at: ts, converged_at: null, merged_at: null,
    fresh_head_run_head: null,
  }];
  return { data, stores, engine, messages };
}

test("#1043: approve then force-push → exactly one review request per head, review-only (no merge-ready, no status flip)", async () => {
  const { data, stores, engine, messages } = setup();
  const posts: string[] = [];
  await withGithub({ reviewCommit: OLD_HEAD, head: NEW_HEAD, posts }, async () => {
    await pollMerges(data, engine, "tok");
    await pollMerges(data, engine, "tok"); // second pass: deduped by the per-head audit marker
  });
  assertEquals(posts.length, 1, "exactly one review request for the stale head");
  // Never bypasses the landing gates: no merge-ready, row stays waiting_merge.
  assertEquals(messages.filter((m) => m.name === "merge-ready").length, 0);
  assertEquals(stores["pull_requests"][0].status, "waiting_merge");
  const audit = stores["merges"].filter((r) => r.outcome === "review-requested");
  assertEquals(audit.length, 1);
  assertEquals(audit[0].detail.includes(NEW_HEAD), true);
});

test("#1043: an unreadable review list never closes an open review wait", async () => {
  const { data, stores, engine } = setup();
  await withGithub({ reviewCommit: OLD_HEAD, head: NEW_HEAD, posts: [] }, () => pollMerges(data, engine, "tok"));
  await withGithub({ reviewCommit: NEW_HEAD, head: NEW_HEAD, reviewsStatus: 502 }, () => pollMerges(data, engine, "tok"));
  assertEquals(reviewWaitReason(stores["merges"]), "waiting_review");
});

test("#1043: a successful POST that never starts a review is withdrawn and re-requested ONCE after the verify window", async () => {
  const { data, stores } = setup();
  const posts: string[] = [];
  const deletes: string[] = [];
  const t0 = Date.parse("2026-11-23T16:00:00Z");
  const fx = { reviewCommit: OLD_HEAD, head: NEW_HEAD, posts, deletes, timeline: [] };
  await withGithub(fx, async () => {
    assertEquals(await ensureHeadReviewRequested(data, "o/r#1856", "o/r", 1856, "tok", t0), "requested");
    // Within the verify window: no retry yet.
    assertEquals(await ensureHeadReviewRequested(data, "o/r#1856", "o/r", 1856, "tok", t0 + 1000), "skipped");
    // Past the window with no copilot_work_started: withdraw + re-add once.
    const late = t0 + POLLER_REVIEW_START_WINDOW_MS + 1000;
    assertEquals(await ensureHeadReviewRequested(data, "o/r#1856", "o/r", 1856, "tok", late), "retried");
    // Bounded: no further asks for this head.
    const later = late + POLLER_REVIEW_START_WINDOW_MS + 1000;
    assertEquals(await ensureHeadReviewRequested(data, "o/r#1856", "o/r", 1856, "tok", later), "skipped");
  });
  assertEquals(posts.length, 2);
  assertEquals(deletes.length, 1);
  assertEquals(stores["merges"].filter((r) => r.outcome === "review-requested").length, 2);
});

test("#1043: a request Copilot DID start is not retried", async () => {
  const { data } = setup();
  const posts: string[] = [];
  const t0 = Date.parse("2026-11-23T16:00:00Z");
  const timeline = [{ event: "copilot_work_started", created_at: "2026-11-23T16:00:30Z" }];
  await withGithub({ reviewCommit: OLD_HEAD, head: NEW_HEAD, posts, deletes: [], timeline }, async () => {
    await ensureHeadReviewRequested(data, "o/r#1856", "o/r", 1856, "tok", t0);
    const late = t0 + POLLER_REVIEW_START_WINDOW_MS + 1000;
    assertEquals(await ensureHeadReviewRequested(data, "o/r#1856", "o/r", 1856, "tok", late), "skipped");
  });
  assertEquals(posts.length, 1);
});

test("#1043: a review landing between passes cannot land the PR — next pass keeps the waiting verdict", async () => {
  const { data, stores, engine, messages } = setup();
  await withGithub({ reviewCommit: OLD_HEAD, head: NEW_HEAD, posts: [] }, () => pollMerges(data, engine, "tok"));
  assertEquals(reviewWaitReason(stores["merges"]), "waiting_review");
  await withGithub({ reviewCommit: NEW_HEAD, head: NEW_HEAD }, () => pollMerges(data, engine, "tok"));
  assertEquals(messages.filter((m) => m.name === "merge-ready").length, 0);
  assertEquals(stores["pull_requests"][0].status, "waiting_merge");
  // The verified head-current review closes the wait so /status stops reporting waiting_review.
  assertEquals(reviewWaitReason(stores["merges"]), null);
  // Idempotent: a further pass does not append another row.
  const n = stores["merges"].length;
  await withGithub({ reviewCommit: NEW_HEAD, head: NEW_HEAD }, () => pollMerges(data, engine, "tok"));
  assertEquals(stores["merges"].length, n);
});

test("#1043: an in-flight Copilot request for the head is adopted, not duplicated", async () => {
  const { data, stores, engine } = setup();
  const posts: string[] = [];
  await withGithub({ reviewCommit: OLD_HEAD, head: NEW_HEAD, pendingCopilot: true, posts }, async () => {
    await pollMerges(data, engine, "tok");
    await pollMerges(data, engine, "tok");
  });
  assertEquals(posts.length, 0, "no new request while one is in flight");
  const audit = stores["merges"].filter((r) => r.outcome === "review-requested");
  assertEquals(audit.length, 1);
  assertEquals(audit[0].detail.includes("adopted"), true);
});

test("#1043: recovery works after the mergeability timeout (timer-only re-poll; no subscription needed)", async () => {
  const { data, stores, engine, messages } = setup();
  stores["pull_requests"][0].waiting_since = "2026-01-01T00:00:00Z"; // long past mergeableWaitTimeout
  const posts: string[] = [];
  await withGithub({ reviewCommit: OLD_HEAD, head: NEW_HEAD, posts }, () => pollMerges(data, engine, "tok"));
  assertEquals(posts.length, 1);
  assertEquals(messages.filter((m) => m.name === "merge-ready").length, 0);
  assertEquals(stores["pull_requests"][0].status, "waiting_merge");
});

test("#1043: a head-current review while waiting → keeps waiting (no request)", async () => {
  const { data, stores, engine, messages } = setup();
  const posts: string[] = [];
  await withGithub({ reviewCommit: NEW_HEAD, head: NEW_HEAD, posts }, () => pollMerges(data, engine, "tok"));
  assertEquals(posts.length, 0);
  assertEquals(messages.filter((m) => m.name === "merge-ready").length, 0);
  assertEquals(stores["pull_requests"][0].status, "waiting_merge");
});

test("#1043: an unreadable review list fails safe (no request)", async () => {
  const { data, stores, engine, messages } = setup();
  const posts: string[] = [];
  await withGithub({ reviewCommit: OLD_HEAD, head: NEW_HEAD, reviewsStatus: 502, posts }, () => pollMerges(data, engine, "tok"));
  assertEquals(posts.length, 0);
  assertEquals(messages.filter((m) => m.name === "merge-ready").length, 0);
  assertEquals(stores["pull_requests"][0].status, "waiting_merge");
});
