// Issue #1043: approve → force-push → the merge stage must REQUEST a head-current review (once per
// head, through the canonical backstop path) instead of waiting forever in `wait-mergeable` for a
// review nothing ever asks for. Poller-level: drive `pollMerges` over a `waiting_merge` row whose
// latest Copilot review is on an OLD head while GitHub still reports the PR as not yet mergeable
// (the `waiting` verdict that used to `continue` silently every pass).
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import { memStatusCas } from "../test/memStatusCas.ts";
import { pollMerges } from "./service.ts";

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
function githubFetch(fx: { reviewCommit: string | null; head: string; reviewsStatus?: number }) {
  return (url: string | URL | Request): Promise<Response> => {
    const u = new URL(String(url));
    const json = (obj: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } }));
    if (u.pathname === "/graphql") {
      return json({
        data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } },
      });
    }
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

test("#1043: approve then force-push → exactly one hand-off to the review-requesting backstop, no silent wait", async () => {
  const { data, stores, engine, messages } = setup();
  await withGithub({ reviewCommit: OLD_HEAD, head: NEW_HEAD }, async () => {
    await pollMerges(data, engine, "tok");
    // A second pass must not re-publish: the row left `waiting_merge` for the backstop's bounded
    // request-and-wait path, which re-arms it only after `reviewRequestWait` (once per head/round).
    await pollMerges(data, engine, "tok");
  });
  const ready = messages.filter((m) => m.name === "merge-ready");
  assertEquals(ready.length, 1, "the stale head must be routed to the backstop exactly once");
  assertEquals(ready[0].variables.mergeState, "ready", "routes through attempt-merge, whose backstop returns review-pending");
  assertEquals(stores["pull_requests"][0].status, "merging");
});

test("#1043: a head-current review while waiting → keeps waiting (no request)", async () => {
  const { data, stores, engine, messages } = setup();
  await withGithub({ reviewCommit: NEW_HEAD, head: NEW_HEAD }, () => pollMerges(data, engine, "tok"));
  assertEquals(messages.filter((m) => m.name === "merge-ready").length, 0);
  assertEquals(stores["pull_requests"][0].status, "waiting_merge");
});

test("#1043: an unreadable review list fails safe (no routing)", async () => {
  const { data, stores, engine, messages } = setup();
  await withGithub({ reviewCommit: OLD_HEAD, head: NEW_HEAD, reviewsStatus: 502 }, () => pollMerges(data, engine, "tok"));
  assertEquals(messages.filter((m) => m.name === "merge-ready").length, 0);
  assertEquals(stores["pull_requests"][0].status, "waiting_merge");
});
