// #702: the merge-loop must auto-recover a PR EVICTED from the GitHub merge queue for ANY reason —
// not only a merge conflict (`DIRTY`). A PR dropped because required checks FAILED on the
// speculative `merge_group` commit (the ALLGREEN-batch invalidation) is NOT `DIRTY` — its head
// reverts to BLOCKED/UNSTABLE/CLEAN — so the old `mergeStateStatus`-only classifier kept it parked
// at `wait-landed` until the PT1H `landedWaitTimeout` escalated to a human. The poller now reads
// GROUND-TRUTH native-queue membership (GraphQL `mergeQueueEntry`) so a clean eviction publishes
// `merge-evicted` (→ `arm-merge` → the mergeable gate re-drives `fix-ci`/`rebase`).
//
// These are poller-level tests: they drive `pollMerges` over a `queued` PR row against a
// token-transport GitHub stub that serves BOTH the REST PR view and the GraphQL merge-queue probe.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import { fetchMergeQueueMembership } from "./github.ts";
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

// A token-transport GitHub stub serving BOTH the REST `GET …/pulls/{n}` (the PR's merge state) and
// the GraphQL merge-queue membership probe. `mergeableState` is the head's `mergeable_state`;
// `hasQueue` says the base branch has a native merge queue; `enrolled` says the PR still holds a
// live `mergeQueueEntry`.
interface Fixture {
  mergeableState: string; // e.g. "blocked" | "unstable" | "clean" | "dirty"
  hasQueue: boolean;
  enrolled: boolean;
}
function githubFetch(fx: Fixture) {
  return (url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const json = (obj: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } }));
    if (u.pathname === "/graphql") {
      return json({
        data: {
          repository: {
            mergeQueue: fx.hasQueue ? { id: "MQ_1" } : null,
            pullRequest: { mergeQueueEntry: fx.enrolled ? { id: "MQE_1" } : null },
          },
        },
      });
    }
    const m = u.pathname.match(/\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/);
    if (m) {
      return json({
        merged: false,
        merged_at: null,
        state: "open",
        mergeable_state: fx.mergeableState,
        draft: false,
        head: { sha: "deadbeef" },
        base: { ref: "main" },
      });
    }
    return Promise.resolve(new Response(`unexpected ${u.pathname}`, { status: 500 }));
  };
}

async function withGithub<T>(fx: Fixture, fn: () => Promise<T>): Promise<T> {
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

function queuedRow(prKey: string, number: number) {
  const ts = "2026-08-20T00:00:00Z";
  return {
    pr_key: prKey,
    repo: "o/r",
    number,
    url: `https://github.com/o/r/pull/${number}`,
    title: "t",
    status: "queued",
    current_round: 0,
    process_key: null,
    waiting_since: null,
    last_review_id: null,
    outcome: null,
    created_at: ts,
    updated_at: ts,
    converged_at: null,
    merged_at: null,
  };
}

test("#702 poller: a queued PR dropped from the queue (not DIRTY) publishes merge-evicted", async () => {
  // The exact CI-on-merge_group eviction: head is BLOCKED (not DIRTY), native queue exists, but the
  // PR is no longer enrolled. The old DIRTY-only classifier stayed silent here.
  const { data, stores } = memData();
  const { engine, messages } = recordingEngine();
  stores["pull_requests"] = [queuedRow("o/r#100", 100)];

  await withGithub({ mergeableState: "blocked", hasQueue: true, enrolled: false }, () =>
    pollMerges(data, engine, "tok"),
  );

  assertEquals(messages.length, 1, "an evicted queued PR must publish exactly one escape message");
  assertEquals(messages[0].name, "merge-evicted");
  assertEquals(messages[0].correlationKey, "o/r#100");
  // Flipped onto the transient `merging` status so a slow next pass can't double-signal.
  assertEquals(stores["pull_requests"][0].status, "merging");
});

test("#702 regression: a queued PR still ENROLLED (BLOCKED pending queue check) stays parked", async () => {
  const { data, stores } = memData();
  const { engine, messages } = recordingEngine();
  stores["pull_requests"] = [queuedRow("o/r#100", 100)];

  await withGithub({ mergeableState: "blocked", hasQueue: true, enrolled: true }, () =>
    pollMerges(data, engine, "tok"),
  );

  assertEquals(messages.length, 0, "a still-enrolled queuing PR must not be falsely evicted");
  assertEquals(stores["pull_requests"][0].status, "queued");
});

test("#702: a repo with NO native merge queue (Mergify/plain) never falsely evicts a queued PR", async () => {
  // `mergeQueueEntry` is perpetually null there — the #556 `landedWaitTimeout` backstop, not a false
  // eviction, must cover a never-lands wedge. So the poller stays silent and the PR stays queued.
  const { data, stores } = memData();
  const { engine, messages } = recordingEngine();
  stores["pull_requests"] = [queuedRow("o/r#100", 100)];

  await withGithub({ mergeableState: "blocked", hasQueue: false, enrolled: false }, () =>
    pollMerges(data, engine, "tok"),
  );

  assertEquals(messages.length, 0, "no native queue → indeterminate membership → keep waiting");
  assertEquals(stores["pull_requests"][0].status, "queued");
});

// #703 (suppressed-advisory follow-up): `fetchMergeQueueMembership` must stay conservative when the
// GraphQL payload carries a native `mergeQueue` but the `pullRequest` node is missing (partial
// `data` alongside `errors`, or an unreadable PR). A null `pullRequest` is INDETERMINATE (`null`),
// never a definitive eviction (`false`) — otherwise a transport hiccup would thrash `arm-merge`.
async function withProbeFetch<T>(body: unknown, fn: () => Promise<T>): Promise<T> {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevFetch = globalThis.fetch;
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  globalThis.fetch = ((): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    )) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prevFetch;
    if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
  }
}

test("#703: a native queue with a MISSING pullRequest node reads indeterminate (null), not evicted", async () => {
  const membership = await withProbeFetch(
    { data: { repository: { mergeQueue: { id: "MQ_1" }, pullRequest: null } } },
    () => fetchMergeQueueMembership("o/r", 100, "main", "tok"),
  );
  assertEquals(membership, null, "missing pullRequest must be indeterminate, never a false eviction");
});

test("#703: a native queue with a live pullRequest entry reads enrolled (true)", async () => {
  const membership = await withProbeFetch(
    { data: { repository: { mergeQueue: { id: "MQ_1" }, pullRequest: { mergeQueueEntry: { id: "MQE_1" } } } } },
    () => fetchMergeQueueMembership("o/r", 100, "main", "tok"),
  );
  assertEquals(membership, true);
});

test("#703: a native queue with a present PR but no entry reads a genuine eviction (false)", async () => {
  const membership = await withProbeFetch(
    { data: { repository: { mergeQueue: { id: "MQ_1" }, pullRequest: { mergeQueueEntry: null } } } },
    () => fetchMergeQueueMembership("o/r", 100, "main", "tok"),
  );
  assertEquals(membership, false);
});
