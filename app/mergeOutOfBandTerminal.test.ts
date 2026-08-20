// Class regression guard for the out-of-band terminal escape shared by EVERY merge-stage durable
// wait (issue #368).
//
// #368: a PR merged (or closed) OUT-OF-BAND — a maintainer clicks Merge, or a mergify queue lands
// it — while its merge-loop instance is parked at a durable GitHub wait can silently wedge forever.
// The `waiting_deps` branch of `pollMerges` only advanced a PR when its *declared dependencies*
// merged and had NO check on the PR itself already being merged: if those deps never cleared, the
// instance sat at `wait-deps` forever (ACTIVE, no incident, no timer boundary). `waiting_merge`
// already guarded this; the fix lifts that guard into ONE shared pre-check
// (`advanceIfTerminalOutOfBand`) run at the top of all four merge-stage waits — `waiting_deps`,
// `waiting_merge`, `waiting_lane`, `queued` — so no stage can strand on an out-of-band terminal
// transition. Each wait subscribes to a DIFFERENT catch, so the pre-check must publish the escape
// message THAT wait correlates to; this test asserts the class over every (status × merged/closed).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import { pollMerges } from "./service.ts";

// In-memory record gateway (get/find/insert/update/delete), matching app/promotionPoll.test.ts.
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

// Records every message the poller publishes so a test can assert the exact escape.
function recordingEngine(): { engine: EngineClient; messages: any[] } {
  const messages: any[] = [];
  const engine = {
    async publishMessage(msg: any) {
      messages.push(msg);
    },
  } as any as EngineClient;
  return { engine, messages };
}

// A token-transport GitHub stub. Serves `GET /repos/{repo}/pulls/{n}` from a per-number liveness
// map so `fetchPrState` (→ `classifyPrLiveness`) reads "merged" / "closed" / "open".
type Live = "merged" | "closed" | "open";
function githubFetch(states: Map<number, Live>) {
  return (url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const json = (obj: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } }));
    const m = u.pathname.match(/\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/);
    if (m) {
      const n = Number(m[1]);
      const live = states.get(n) ?? "open";
      return json({
        merged: live === "merged",
        merged_at: live === "merged" ? "2026-08-20T02:35:42Z" : null,
        state: live === "open" ? "open" : "closed",
        mergeable_state: live === "open" ? "clean" : "unknown",
        draft: false,
        head: { sha: "deadbeef" },
      });
    }
    return Promise.resolve(new Response(`unexpected ${u.pathname}`, { status: 500 }));
  };
}

async function withGithub<T>(states: Map<number, Live>, fn: () => Promise<T>): Promise<T> {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevFetch = globalThis.fetch;
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  globalThis.fetch = githubFetch(states) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prevFetch;
    if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
  }
}

function prRow(prKey: string, number: number, status: string) {
  const ts = "2026-08-20T00:00:00Z";
  return {
    pr_key: prKey,
    repo: "o/r",
    number,
    url: `https://github.com/o/r/pull/${number}`,
    title: "t",
    status,
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

// Every merge-stage durable wait, with the escape message its parked catch subscribes to. The
// escape differs per wait because each subscribes to a different message — the whole point of the
// shared pre-check is to publish the RIGHT one so it correlates instead of being dropped.
const CASES: { status: string; merged: string; closed: string }[] = [
  // wait-deps subscribes only `deps-cleared` (→ arm-merge → wait-mergeable, where block 2 converges).
  { status: "waiting_deps", merged: "deps-cleared", closed: "deps-cleared" },
  // wait-mergeable subscribes `merge-ready` (→ gw-mergeable → attempt-merge terminal short-circuits).
  { status: "waiting_merge", merged: "merge-ready", closed: "merge-ready" },
  // waiting_lane is an app hold that leaves the process on wait-mergeable → also `merge-ready`.
  { status: "waiting_lane", merged: "merge-ready", closed: "merge-ready" },
  // wait-landed subscribes `merge-landed` (→ mark-merged) and `merge-evicted` (→ arm-merge). A
  // merged queue PR lands; a closed one can never land, so re-arm and let block 2 abandon it.
  { status: "queued", merged: "merge-landed", closed: "merge-evicted" },
];

for (const c of CASES) {
  for (const live of ["merged", "closed"] as const) {
    test(`out-of-band ${live} PR at ${c.status} converges via ${live === "merged" ? c.merged : c.closed}`, async () => {
      const { data, stores } = memData();
      const { engine, messages } = recordingEngine();
      stores["pull_requests"] = [prRow("o/r#100", 100, c.status)];
      // A declared dependency that has NOT merged — the exact condition that wedged `waiting_deps`:
      // the deps loop would never clear, so ONLY the PR's own terminal state can converge it.
      stores["pr_dependencies"] = [{ pr_key: "o/r#100", depends_on_key: "o/r#200", created_at: "t" }];

      await withGithub(new Map<number, Live>([[100, live], [200, "open"]]), () =>
        pollMerges(data, engine, "tok"),
      );

      assertEquals(messages.length, 1, `expected exactly one escape message for ${c.status}/${live}`);
      const expected = live === "merged" ? c.merged : c.closed;
      assertEquals(messages[0].name, expected);
      assertEquals(messages[0].correlationKey, "o/r#100");
      if (expected === "merge-ready") assertEquals(messages[0].variables.mergeState, "ready");
      // Flipped onto the transient `merging` status so a slow pass can't double-signal.
      assertEquals(stores["pull_requests"][0].status, "merging");
    });
  }
}

// Negative guard: a still-OPEN `waiting_deps` PR whose declared dep is unmerged must NOT be forced
// terminal by the pre-check — it stays parked (no escape published), proving the pre-check fires
// only on a real out-of-band terminal transition and never drops a live PR.
test("still-open waiting_deps PR with an unmerged dep publishes nothing and stays parked", async () => {
  const { data, stores } = memData();
  const { engine, messages } = recordingEngine();
  stores["pull_requests"] = [prRow("o/r#100", 100, "waiting_deps")];
  stores["pr_dependencies"] = [{ pr_key: "o/r#100", depends_on_key: "o/r#200", created_at: "t" }];

  await withGithub(new Map<number, Live>([[100, "open"], [200, "open"]]), () =>
    pollMerges(data, engine, "tok"),
  );

  assertEquals(messages.length, 0);
  assertEquals(stores["pull_requests"][0].status, "waiting_deps");
});
