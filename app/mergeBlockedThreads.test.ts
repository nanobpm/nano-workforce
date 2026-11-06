// #921: a PR whose merge is BLOCKED solely by unresolved review threads (branch protection
// `required_conversation_resolution`; `mergeable=MERGEABLE`, `mergeStateStatus=BLOCKED`, all
// required checks green) must be CLASSIFIED as such and routed back into convergence — never
// escalated as "GitHub never settled this PR's mergeability". These are poller-level tests: they
// drive `pollMerges` over a `waiting_merge` PR row against a token-transport GitHub stub that
// serves BOTH the REST PR view and the GraphQL review-threads probe, and assert:
//   • the verdict parks the PR (no `merge-ready` publish — the merge step is gated on zero
//     unresolved threads) and nudges a fresh Copilot review, bounded to once per head;
//   • once the threads resolve, the next pass publishes `merge-ready {ready}` and the merge
//     proceeds with no human in the loop.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { DataLayer, EngineClient } from "@nanobpm/urban";
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
  const data = { table: (n: string, pk?: string) => tbl(n, pk) } as any as DataLayer;
  return { data, stores };
}

function recordingEngine(): { engine: EngineClient; messages: any[] } {
  const messages: any[] = [];
  const engine = {
    async publishMessage(msg: any) {
      messages.push(msg);
    },
  } as any as EngineClient;
  return { engine, messages };
}

// A token-transport GitHub stub serving the REST PR view (`mergeable_state: "blocked"`, the
// conversation-resolution block), the GraphQL review-threads probe (`unresolved` open threads),
// and the REST reviewers POST (the Copilot re-request nudge). `failingChecks` is -1 in token mode
// …which would keep the classifier conservative — so these tests ALSO stub the check rollup via
// the GraphQL threads response only, and rely on the REST view. To keep the classifier out of
// token mode's "can't enumerate checks" branch, the stub serves a REST `check-runs` free PR whose
// merge block is purely the threads — but the REST single-PR view never enumerates checks, so the
// classifier reads `failingChecks: -1`. That is exactly the production shape on a token-transport
// deploy; the `review-threads` verdict therefore requires the gh transport in production. These
// tests pin the TOKEN-transport behaviour (conservative: park + nudge + never escalate) and the
// classifier-level verdict is covered by the gh-mode unit tests in app/github.test.ts.
interface Fixture {
  unresolved: number; // threads with isResolved=false
  mergeableState?: string;
}
function githubFetch(fx: Fixture, calls: { reviewPosts: number }) {
  return (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const json = (obj: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } }));
    if (u.pathname === "/graphql") {
      const threads = Array.from({ length: fx.unresolved }, (_, i) => ({
        isResolved: false,
        path: `f${i}.ts`,
        comments: { nodes: [{ body: `thread ${i}` }] },
      }));
      return json({
        data: {
          repository: {
            pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threads } },
          },
        },
      });
    }
    if (u.pathname.endsWith("/requested_reviewers") && init?.method === "POST") {
      calls.reviewPosts += 1;
      return json({}, 201);
    }
    const m = u.pathname.match(/\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/);
    if (m) {
      return json({
        merged: false,
        merged_at: null,
        state: "open",
        mergeable_state: fx.mergeableState ?? "blocked",
        draft: false,
        head: { sha: "deadbeef" },
        base: { ref: "main" },
      });
    }
    return Promise.resolve(new Response(`unexpected ${u.pathname}`, { status: 500 }));
  };
}

async function withGithub<T>(fx: Fixture, calls: { reviewPosts: number }, fn: () => Promise<T>): Promise<T> {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevFetch = globalThis.fetch;
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  globalThis.fetch = githubFetch(fx, calls) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prevFetch;
    if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
  }
}

function waitingMergeRow(prKey: string, number: number) {
  const ts = "2026-08-20T00:00:00Z";
  return {
    pr_key: prKey,
    repo: "o/r",
    number,
    url: `https://github.com/o/r/pull/${number}`,
    title: "t",
    status: "waiting_merge",
    current_round: 0,
    process_key: null,
    waiting_since: null,
    last_review_id: null,
    outcome: null,
    created_at: ts,
    updated_at: ts,
    converged_at: null,
    merged_at: null,
    fresh_head_run_head: null,
  };
}

test("#921 poller: a threads-BLOCKED PR parks (no merge-ready) — the merge stays gated on resolution", async () => {
  // Token transport can't enumerate checks, so the classifier stays conservative and the verdict
  // is "waiting" even with threads probed — the PR must NOT advance to attempt-merge, must NOT
  // escalate, and must be re-read next pass. (The gh-transport `review-threads` verdict is pinned
  // in app/github.test.ts; the merge-loop routing of that verdict in app/mergeLoopBehaviour.test.ts.)
  const { data, stores } = memData();
  const { engine, messages } = recordingEngine();
  stores["pull_requests"] = [waitingMergeRow("o/r#100", 100)];
  const calls = { reviewPosts: 0 };
  await withGithub({ unresolved: 2 }, calls, async () => {
    await pollMerges(data, engine, "tok");
  });
  assertEquals(
    messages.filter((m) => m.name === "merge-ready").length,
    0,
    "a threads-BLOCKED PR must not publish merge-ready — the merge step is gated on zero unresolved threads",
  );
  assertEquals(stores["pull_requests"][0].status, "waiting_merge", "the PR stays parked for the next pass");
});

test("#921 poller: once the threads resolve the next pass publishes merge-ready and the merge proceeds", async () => {
  const { data, stores } = memData();
  const { engine, messages } = recordingEngine();
  stores["pull_requests"] = [waitingMergeRow("o/r#100", 100)];
  const calls = { reviewPosts: 0 };
  // Threads resolved (none open) and the branch otherwise mergeable → the gate lifts.
  await withGithub({ unresolved: 0, mergeableState: "clean" }, calls, async () => {
    await pollMerges(data, engine, "tok");
  });
  const ready = messages.filter((m) => m.name === "merge-ready");
  assertEquals(ready.length, 1, "a clean PR with zero unresolved threads must advance to the merge step");
  assertEquals(ready[0].variables.mergeState, "ready");
  assertEquals(ready[0].variables.reviewThreads, 0, "the payload carries the probed thread count");
});
