// #921: a PR whose merge is BLOCKED solely by unresolved review threads (branch protection
// `required_conversation_resolution`; `mergeable=MERGEABLE`, `mergeStateStatus=BLOCKED`, all
// required checks green) must be CLASSIFIED as such and routed back into convergence — never
// escalated as "GitHub never settled this PR's mergeability". These are poller-level tests: they
// drive `pollMerges` over a `waiting_merge` PR row against a stubbed GitHub transport serving the
// PR view + the GraphQL review-threads probe, and assert:
//   • the verdict parks the PR (no `merge-ready` publish — the merge step is gated on zero
//     unresolved threads);
//   • once the threads resolve, the next pass publishes `merge-ready {ready}` and the merge
//     proceeds with no human in the loop;
//   • a `review-threads` verdict hands the PR DURABLY back into convergence (PR #922 review): the
//     row flips to `waiting_review` and a fresh convergence instance is started, so the
//     review-fix agent actually activates on the open threads — a bare re-review request leaves
//     the PR in `waiting_merge`, which `pollReviews` never scans.
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals } from "#test-assert";
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import { pollMerges } from "./service.ts";

/** A single-page GraphQL review-threads payload with `n` unresolved threads, for the gh stub. */
function graphqlThreads(n: number): string {
  const threads = Array.from({ length: n }, (_, i) => ({
    isResolved: false,
    path: `f${i}.ts`,
    comments: { nodes: [{ body: `thread ${i}` }] },
  }));
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threads } },
      },
    },
  });
}

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
  // `data.open()` is the raw-statement escape hatch a few reconcilers use. The in-memory stub has
  // no SQL store, so apply the one statement this suite's domain flow issues — `submitPr`'s re-open
  // path runs `resetAdjudications` (`DELETE FROM "pr_adjudications" WHERE "pr_key" = ?`) — against
  // the in-memory rows, so the handoff test below genuinely observes the adjudication reset rather
  // than a no-op. Any other statement throws loudly instead of silently passing.
  const data = {
    table: (n: string, pk?: string) => tbl(n, pk),
    open: () => ({
      exec: async (sql: string, params: any[] = []) => {
        const m = sql.match(/^\s*DELETE\s+FROM\s+"?(\w+)"?\s+WHERE\s+"?(\w+)"?\s*=\s*\?\s*$/i);
        if (!m) throw new Error(`memData.open().exec: unsupported statement: ${sql}`);
        const rows = (stores[m[1]] ??= [] as any[]);
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i][m[2]] === params[0]) rows.splice(i, 1);
      },
    }),
  } as any as DataLayer;
  return { data, stores };
}

function recordingEngine(): { engine: EngineClient; messages: any[]; cancelled: string[] } {
  const messages: any[] = [];
  const cancelled: string[] = [];
  const engine = {
    async publishMessage(msg: any) {
      messages.push(msg);
    },
    async cancelInstance(args: { processInstanceKey: string }) {
      cancelled.push(String(args.processInstanceKey));
    },
  } as any as EngineClient;
  return { engine, messages, cancelled };
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
  assertEquals(ready[0].variables.pendingChecks, 0, "the payload carries the pending-check count (token mode: unenumerable → 0)");
});

test("#921/PR#922 poller: a 'review-threads' verdict hands the PR back into convergence — the remediation agent actually activates", async () => {
  // gh transport: checks enumerable and green, merge BLOCKED, two unresolved threads → the settled
  // `review-threads` verdict. The poller must NOT merely request another Copilot review (that
  // leaves the PR in `waiting_merge`, which `pollReviews` never scans — no review-fix agent would
  // ever activate); it re-enters the PR into the canonical convergence loop: the row flips to
  // `waiting_review` and a FRESH convergence instance is created.
  //
  // The row's `process_key` names the LIVE merge instance (the realistic merge-stage shape). The
  // handoff must RETIRE it first (PR #922 review, thread 3): left running, `submitPr`'s idempotency
  // gate would classify the PR `alreadyRunning` and start NOTHING — no convergence instance would
  // ever launch and the old merge timer would keep running. Cancelling it flips the derived
  // tracking status terminal, so the gate falls through and the fresh convergence run takes over.
  const { data, stores } = memData();
  const instances: any[] = [];
  const { engine, cancelled } = recordingEngine();
  (engine as any).createInstance = async (args: any) => {
    instances.push(args);
    return { processInstanceKey: "conv-1" };
  };
  const mergeRow = { ...waitingMergeRow("o/r#100", 100), process_key: "merge-1" };
  stores["pull_requests"] = [mergeRow];
  // The derived tracking VIEW the idempotency gate reads: the merge instance is LIVE (non-terminal)
  // until the handoff's `cancelInstance` retires it. The stub folds the row to a terminal edge
  // (`abandoned`) once its `process_key` is cancelled, mirroring the ADR-0065 reconciler.
  stores["pull_requests__tracking"] = [{ ...mergeRow, derived_status: "waiting_merge" }];
  (engine as any).cancelInstance = async (args: { processInstanceKey: string }) => {
    cancelled.push(String(args.processInstanceKey));
    for (const t of stores["pull_requests__tracking"]) {
      if (t.process_key === String(args.processInstanceKey)) t.derived_status = "abandoned";
    }
  };
  // A stale adjudication from the prior convergence run must be wiped by the re-open, so the fresh
  // run never replays a prior decision (issue #806 reset, exercised through the handoff path).
  stores["pr_adjudications"] = [{ pr_key: "o/r#100", question: "q", answer: "a" }];
  const calls = { reviewPosts: 0 };
  // The gh transport runs the `gh` CLI; intercept it with a stub on PATH that serves the PR view
  // (checks green, merge blocked) and the GraphQL review-threads probe from the fixture.
  const bin = await mkdtemp(join(tmpdir(), "gh-stub-"));
  const script = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"pr view"* ]]; then
  echo '{"state":"OPEN","mergedAt":null,"mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"build","status":"COMPLETED","conclusion":"SUCCESS"}],"isDraft":false,"headRefOid":"deadbeef","baseRefName":"main"}'
elif [[ "$*" == *"graphql"* ]]; then
  echo '${graphqlThreads(2)}'
elif [[ "$*" == *"requested_reviewers"* ]]; then
  exit 0
else
  echo "unexpected gh args: $*" >&2
  exit 1
fi
`;
  await writeFile(join(bin, "gh"), script, { mode: 0o755 });
  const prevPath = process.env.PATH;
  const prevFetch = globalThis.fetch;
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  process.env.PATH = `${bin}:${prevPath ?? ""}`;
  // Pin the gh transport: `auto` would work too (the PATH stub answers the availability probe),
  // but the explicit mode is immune to the memoized probe result leaking in from another test file.
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "gh";
  globalThis.fetch = (() => Promise.resolve(new Response("no fetch in gh mode", { status: 500 }))) as typeof fetch;
  try {
    await pollMerges(data, engine, "tok");
  } finally {
    globalThis.fetch = prevFetch;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
    await rm(bin, { recursive: true, force: true });
  }
  const row = stores["pull_requests"][0];
  assertEquals(cancelled, ["merge-1"], "the live merge instance is retired before the re-open");
  assertEquals(row.status, "converging", "the re-opened PR row presents the fresh convergence run");
  assertEquals(row.process_key, "conv-1", "the row is re-pointed at the fresh convergence instance");
  assertEquals(instances.length, 1, "exactly one fresh convergence instance is started");
  assertEquals(instances[0].processDefinitionId, "convergence-loop", "the canonical convergence loop is re-entered");
  assertEquals(instances[0].variables.prKey, "o/r#100");
  assertEquals(instances[0].variables.round, 1, "the fresh run restarts at round 1");
  assertEquals(calls.reviewPosts, 0, "no bare re-review request — the handoff, not a nudge, drives remediation");
  assertEquals(stores["pr_adjudications"].length, 0, "the re-open wipes the prior run's adjudication memory (#806)");
});
