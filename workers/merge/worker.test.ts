// Regression for the out-of-band merge wedge (Magikcraft/nano-bpm#723): when a PR is merged
// independently of the process (a maintainer clicks Merge, a mergify queue lands it), the poller
// routes the merge-loop instance back through `attempt-merge`. This worker must detect the
// already-merged state and complete the loop directly — NOT re-run the land protocol, which would post a
// spurious `@mergifyio queue` comment (mergify-queue repos) or a redundant merge call. Forces the
// token transport and stubs `globalThis.fetch` so the single-PR GET reports `merged: true`.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import handler from "./worker.ts";

function fakeApp() {
  const stores: Record<string, Record<string, unknown>[]> = {
    pull_requests: [],
    merges: [],
  };
  return {
    app: {
      data: {
        table(name: string, key: string) {
          const store = (stores[name] ??= []);
          return {
            get: (k: any) => Promise.resolve(store.find((r) => r[key] === k)),
            find: (q: any) =>
              Promise.resolve(
                store.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v)),
              ),
            insert: (row: any) => {
              store.push(row);
              return Promise.resolve(store.length);
            },
            update: (k: any, patch: any) => {
              const row = store.find((r) => r[key] === k);
              if (row) Object.assign(row, patch);
              return Promise.resolve(row);
            },
          };
        },
      },
      log: () => undefined,
      engine: {},
    } as any,
    stores,
  };
}

function withMergedPr(run: (calls: string[]) => Promise<void>): Promise<void> {
  const oldTransport = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const oldToken = process.env["GITHUB_TOKEN"];
  const oldFetch = globalThis.fetch;
  const calls: string[] = [];
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  process.env["GITHUB_TOKEN"] = "test-token";
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    // Single-PR GET → report the PR as already merged.
    if (/\/pulls\/\d+$/.test(url)) {
      return Promise.resolve(new Response(JSON.stringify({ merged: true, mergeable_state: "clean" })));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
  return run(calls).finally(() => {
    if (oldTransport == null) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = oldTransport;
    if (oldToken == null) delete process.env["GITHUB_TOKEN"];
    else process.env["GITHUB_TOKEN"] = oldToken;
    globalThis.fetch = oldFetch;
  });
}

test("pr.merge short-circuits an already-merged PR without re-running the land protocol", async () => {
  await withMergedPr(async (calls) => {
    const { app, stores } = fakeApp();
    const out = (await handler(
      {
        variables: {
          prKey: "Magikcraft/nano-bpm#723",
          repo: "Magikcraft/nano-bpm",
          prNumber: 723,
        },
      } as any,
      app,
    )) as Record<string, unknown>;

    // Completes the loop directly.
    assertEquals(out, { mergeStatus: "merged" });

    // Records exactly one audit row, tagged as the idempotent already-merged path.
    assertEquals(stores.merges.length, 1);
    assertEquals(stores.merges[0].outcome, "merged");
    assertEquals(stores.merges[0].method, "already-merged");

    // Never posts an enqueue comment or issues a merge call (only the read GET happened).
    assertEquals(calls.some((u) => /comments|merge$/.test(u)), false);
  });
});
