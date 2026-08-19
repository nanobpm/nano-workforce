// Regression for the out-of-band merge wedge (Magikcraft/nano-bpm#723): when a PR is merged
// independently of the process (a maintainer clicks Merge, a mergify queue lands it), the poller
// routes the merge-loop instance back through `attempt-merge`. This worker must detect the
// already-merged state and complete the loop directly — NOT re-run the land protocol, which would post a
// spurious `@mergifyio queue` comment (mergify-queue repos) or a redundant merge call. Forces the
// token transport and stubs `globalThis.fetch` so the single-PR GET reports `merged: true`.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { _clearMergeProtocolCache } from "../../app/mergeProtocol.ts";
import { noopLog } from "../../test/log.ts";
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
      log: noopLog(),
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

// The land protocol has three terminal outcomes, dispatched by the worker's exhaustive `matchTags`
// (worker.ts §"Exhaustive dispatch"). The already-merged short-circuit above never reaches that
// dispatch, so the two land branches below — `queued` (repo lands via an on-demand merge queue) and
// `blocked` (GitHub refuses the merge) — pin the behaviour of that critical terminal switch so a
// regression in any arm is caught. Both drive the token transport and route GitHub calls through a
// stubbed `globalThis.fetch`.
// Each recorded call keeps the HTTP method alongside the URL so tests can assert not just *which*
// endpoint the worker hit but *how* (e.g. enqueue via POST, merge via PUT) — a URL-only matcher
// would stay green if the verb regressed.
type GithubCall = { url: string; method: string };

function withGithub(
  routes: (url: string, init: RequestInit | undefined) => Response | null,
  run: (calls: GithubCall[]) => Promise<void>,
): Promise<void> {
  const oldTransport = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const oldToken = process.env["GITHUB_TOKEN"];
  const oldFetch = globalThis.fetch;
  const calls: GithubCall[] = [];
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  process.env["GITHUB_TOKEN"] = "test-token";
  _clearMergeProtocolCache();
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    const res = routes(url, init);
    return Promise.resolve(res ?? new Response("not found", { status: 404 }));
  }) as typeof fetch;
  return run(calls).finally(() => {
    if (oldTransport == null) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = oldTransport;
    if (oldToken == null) delete process.env["GITHUB_TOKEN"];
    else process.env["GITHUB_TOKEN"] = oldToken;
    globalThis.fetch = oldFetch;
    _clearMergeProtocolCache();
  });
}

test("pr.merge routes a mergify-queue repo through the queued branch (enqueue comment, status=queued)", async () => {
  // AGENTS.md publishes a mergify-queue land protocol, so the worker enqueues via a comment rather
  // than issuing a direct merge; the queued arm of `matchTags` marks the PR `queued` and returns.
  const protocol =
    "# repo\n\n```merge-protocol\n{ \"land\": { \"method\": \"mergify-queue\", \"comment\": \"@mergifyio queue\" } }\n```\n";
  await withGithub(
    (url) => {
      if (/\/contents\/AGENTS\.md$/.test(url)) return new Response(protocol);
      if (/\/pulls\/\d+$/.test(url)) return new Response(JSON.stringify({ merged: false, mergeable_state: "clean" }));
      if (/\/issues\/\d+\/comments$/.test(url)) return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      return null;
    },
    async (calls) => {
      const { app, stores } = fakeApp();
      const out = (await handler(
        { variables: { prKey: "acme/widgets#7", repo: "acme/widgets", prNumber: 7 } } as any,
        app,
      )) as Record<string, unknown>;

      // Queued arm: waits for `merge-landed`, so it reports `queued` (not `merged`/`blocked`).
      assertEquals(out, { mergeStatus: "queued" });

      // Enqueued via the protocol's comment (POST), never a direct merge PUT.
      assertEquals(
        calls.some((c) => /\/issues\/\d+\/comments$/.test(c.url) && c.method === "POST"),
        true,
      );
      assertEquals(calls.some((c) => /\/merge$/.test(c.url)), false);

      // Audit row records the queue-comment land, and the PR row is flipped to `queued`.
      assertEquals(stores.merges.length, 1);
      assertEquals(stores.merges[0].outcome, "queued");
      assertEquals(stores.merges[0].method, "queue-comment");
      assertEquals(stores.pull_requests.find((r) => r.pr_key === "acme/widgets#7")?.status, "queued");
    },
  );
});

test("pr.merge routes a refused merge through the blocked branch (escalation payload)", async () => {
  // Default (gh-merge) protocol; GitHub refuses the merge PUT, so `mergePr` reports `blocked` and the
  // blocked arm of `matchTags` shapes the human-facing escalation question from the failure detail.
  await withGithub(
    (url) => {
      if (/\/pulls\/\d+\/merge$/.test(url))
        return new Response("Pull Request is not mergeable", { status: 405, statusText: "Method Not Allowed" });
      if (/\/pulls\/\d+$/.test(url)) return new Response(JSON.stringify({ merged: false, mergeable_state: "dirty" }));
      return null; // no AGENTS.md / merge-protocol.json → DEFAULT gh-merge protocol
    },
    async (calls) => {
      const { app, stores } = fakeApp();
      const out = (await handler(
        { variables: { prKey: "acme/widgets#9", repo: "acme/widgets", prNumber: 9 } } as any,
        app,
      )) as Record<string, unknown>;

      // Blocked arm: surfaces both the loop-terminal `mergeStatus` and the escalation `status`.
      assertEquals(out.mergeStatus, "blocked");
      assertEquals(out.status, "blocked");
      assertEquals(typeof out.question, "string");
      assertEquals((out.question as string).startsWith("Automated merge was blocked:"), true);

      // Attempted a real merge PUT (not an enqueue comment), and recorded a blocked audit row.
      assertEquals(
        calls.some((c) => /\/pulls\/\d+\/merge$/.test(c.url) && c.method === "PUT"),
        true,
      );
      assertEquals(calls.some((c) => /\/comments$/.test(c.url)), false);
      assertEquals(stores.merges.length, 1);
      assertEquals(stores.merges[0].outcome, "blocked");
    },
  );
});

test("pr.merge routes a transient base-moved race through the retry branch (no escalation payload)", async () => {
  // #334: GitHub aborts the merge PUT with the 405 "Base branch was modified. Review and try the
  // merge again." race. `mergePr` classifies it as `retry` (not `blocked`), and the retry arm of
  // `matchTags` returns ONLY the loop-terminal `mergeStatus` — no `status`/`question` escalation
  // payload — so the model re-attempts on the settled base instead of paging a human.
  await withGithub(
    (url) => {
      if (/\/pulls\/\d+\/merge$/.test(url))
        return new Response("Base branch was modified. Review and try the merge again.", {
          status: 405,
          statusText: "Method Not Allowed",
        });
      if (/\/pulls\/\d+$/.test(url)) return new Response(JSON.stringify({ merged: false, mergeable_state: "clean" }));
      return null; // no AGENTS.md / merge-protocol.json → DEFAULT gh-merge protocol
    },
    async (calls) => {
      const { app, stores } = fakeApp();
      const out = (await handler(
        { variables: { prKey: "acme/widgets#11", repo: "acme/widgets", prNumber: 11 } } as any,
        app,
      )) as Record<string, unknown>;

      // Retry arm: transient — surfaces the loop-terminal `mergeStatus` only, NO escalation fields.
      assertEquals(out, { mergeStatus: "retry" });
      assertEquals(out.status, undefined);
      assertEquals(out.question, undefined);

      // Attempted a real merge PUT and recorded the retry audit row (not a swallowed block).
      assertEquals(
        calls.some((c) => /\/pulls\/\d+\/merge$/.test(c.url) && c.method === "PUT"),
        true,
      );
      assertEquals(stores.merges.length, 1);
      assertEquals(stores.merges[0].outcome, "retry");
    },
  );
});

test("pr.merge abandons a closed-not-merged PR without escalating (terminal abandon, #342)", async () => {
  // #342/#350: a PR CLOSED on GitHub without merging (e.g. superseded by a newer PR) can never
  // land. The worker must NOT fall through to the land protocol — that returns blocked/conflict and
  // escalates a merge no human can complete, orphaning the process on a dead PR. Instead it records
  // a terminal `abandoned` audit row and returns `mergeStatus:"abandoned"` (the model's
  // terminate/abandon end event), opening NO escalation. Symmetric with the already-merged
  // short-circuit; both are decided from the same single live-state read.
  await withGithub(
    (url) => {
      // Single-PR GET → PR is closed (state="closed") and NOT merged.
      if (/\/pulls\/\d+$/.test(url))
        return new Response(JSON.stringify({ merged: false, state: "closed", mergeable_state: "dirty" }));
      return null; // no AGENTS.md / merge-protocol.json → DEFAULT gh-merge protocol
    },
    async (calls) => {
      const { app, stores } = fakeApp();
      const out = (await handler(
        { variables: { prKey: "acme/widgets#13", repo: "acme/widgets", prNumber: 13 } } as any,
        app,
      )) as Record<string, unknown>;

      // Abandon short-circuit: loop-terminal `mergeStatus` only, NO escalation payload.
      assertEquals(out, { mergeStatus: "abandoned" });
      assertEquals(out.status, undefined);
      assertEquals(out.question, undefined);

      // Records exactly one terminal audit row tagged as the closed-PR abandon path.
      assertEquals(stores.merges.length, 1);
      assertEquals(stores.merges[0].outcome, "abandoned");
      assertEquals(stores.merges[0].method, "pr-closed");

      // Flips the PR row to the terminal `abandoned` status. This path drives a terminate end event
      // that runs NO mark-merged/mark-abandoned worker, so the worker must set the terminal status
      // itself — otherwise the row stays in a non-terminal in-flight status (e.g. `merging`) and is
      // tracked/scanned forever even though the merge loop is done (#342 review).
      const prRow = stores.pull_requests.find((r) => r.pr_key === "acme/widgets#13");
      assertEquals(prRow?.status, "abandoned");

      // Never attempts a merge PUT or posts an enqueue comment on the dead PR (only the read GET).
      assertEquals(calls.some((c) => /\/merge$/.test(c.url)), false);
      assertEquals(calls.some((c) => /\/comments$/.test(c.url)), false);
    },
  );
});
