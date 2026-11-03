// Unit coverage for pr.record-feature's "PR opened" issue link (issue #907).
//
// record-feature is the ONE point every PR-delivering path of a single-issue feature run passes
// through — the agent's own `opened`, a retry's `opened`, and the reconcile step's ADOPTED `opened`
// all land here — so it is the canonical host-side writer of the idempotent
// `🤖 Pull request opened: #n` comment on the claimed issue. The decision itself lives in
// app/issuePrLink.ts (exhaustively covered in app/issuePrLink.test.ts); these tests pin the
// WIRING: the worker calls it only for a claimed (single-issue) run that delivered a keyed PR,
// and a failed comment never fails the job.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { noopLog } from "../../test/log.ts";
import handler from "./worker.ts";

// biome-ignore lint/suspicious/noExplicitAny: tiny in-memory app double, mirrors record-feature-implementing.worker.test
function fakeApp(rows: Record<string, unknown>[]): { app: any; claimAttempts: number[] } {
  const stores: Record<string, Record<string, unknown>[]> = { feature_runs: rows };
  const claimAttempts: number[] = [];
  return {
    app: {
      stores,
      data: {
        table(name: string, key: string) {
          const store = (stores[name] ??= []);
          return {
            // biome-ignore lint/suspicious/noExplicitAny: test double
            get: (k: any) => Promise.resolve(store.find((r) => r[key] === k)),
            // biome-ignore lint/suspicious/noExplicitAny: test double
            update: (k: any, patch: any) => {
              const row = store.find((r) => r[key] === k);
              if (row) Object.assign(row, patch);
              return Promise.resolve(row);
            },
          };
        },
        open() {
          return {
            exec(sql: string, params: unknown[]) {
              claimAttempts.push(1);
              // Mirror the CAS claim/release on the in-memory row so the link record is observable.
              const row = stores.feature_runs[0];
              if (/SET "pr_linked_pr_key" = NULL/.test(sql)) {
                if (row) row.pr_linked_pr_key = null;
                return { changed: 1 };
              }
              if (row) row.pr_linked_pr_key = String(params[0]);
              return { changed: 1 };
            },
          };
        },
      },
      log: noopLog(),
    },
    claimAttempts,
  };
}

/** Hermetic GitHub stub (token transport + fetch double) capturing posted comment bodies. */
function stubGithubComments(existing: { body: string }[] = [], opts: { failPost?: boolean } = {}) {
  const prevTransport = process.env.NANO_PR_GITHUB_TRANSPORT;
  const prevToken = process.env.GITHUB_TOKEN;
  const prevFetch = globalThis.fetch;
  process.env.NANO_PR_GITHUB_TRANSPORT = "token";
  process.env.GITHUB_TOKEN = "t";
  const posted: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const u = new URL(String(url));
    if (method === "GET" && /\/issues\/\d+\/comments$/.test(u.pathname)) {
      return new Response(JSON.stringify(existing), { status: 200 });
    }
    if (method === "GET" && /\/issues\/\d+$/.test(u.pathname)) {
      return new Response(JSON.stringify({ title: "the issue" }), { status: 200 });
    }
    if (method === "GET" && /\/pulls\/\d+$/.test(u.pathname)) {
      return new Response(JSON.stringify({ title: "the PR" }), { status: 200 });
    }
    if (method === "POST" && /\/issues\/\d+\/comments$/.test(u.pathname)) {
      if (opts.failPost) return new Response("boom", { status: 500 });
      // biome-ignore lint/plugin: runtime contract boundary for parsed JSON in a test double
      posted.push(String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? ""));
      return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
  return {
    posted,
    restore: () => {
      globalThis.fetch = prevFetch;
      if (prevTransport === undefined) delete process.env.NANO_PR_GITHUB_TRANSPORT;
      else process.env.NANO_PR_GITHUB_TRANSPORT = prevTransport;
      if (prevToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prevToken;
    },
  };
}

const ROW = { feature_key: "owner/repo#7", repo: "owner/repo", issue_number: 7, status: "running" };

test("an opened run on a claimed issue posts the PR-opened comment and records the link", async () => {
  const gh = stubGithubComments();
  const rows = [{ ...ROW }];
  const { app } = fakeApp(rows);
  try {
    const out = await handler(
      { jobKey: "j1", variables: { featureKey: "owner/repo#7", status: "opened", pr: "owner/repo#101", claimIssue: true } } as never,
      app,
    );
    assertEquals(out.featureStatus, "opened");
    assertEquals(out.prKey, "owner/repo#101");
    assertEquals(gh.posted.length, 1, "the claimed issue got the PR-opened comment");
    assert(gh.posted[0].includes("Pull request opened: #101"), "the comment names the PR");
    assert(gh.posted[0].includes("<!-- nwf:pr-linked:#101 -->"), "the comment carries the dedupe marker");
    assertEquals(rows[0].pr_linked_pr_key, "owner/repo#101", "the durable link was recorded");
  } finally {
    gh.restore();
  }
});

test("an ADOPTED opened (reconcile path) posts the comment too — the worker cannot tell the difference", async () => {
  const gh = stubGithubComments();
  const rows = [{ ...ROW }];
  const { app } = fakeApp(rows);
  try {
    // The reconcile step re-emitted status=opened + pr for a PR the harness never reported; the
    // record worker treats it exactly like an agent-reported opened.
    await handler(
      { jobKey: "j2", variables: { featureKey: "owner/repo#7", status: "opened", pr: "owner/repo#801", claimIssue: true } } as never,
      app,
    );
    assertEquals(gh.posted.length, 1, "the adopted PR was announced on the issue");
    assert(gh.posted[0].includes("#801"), "the comment names the adopted PR");
  } finally {
    gh.restore();
  }
});

test("a repeated record pass for the SAME PR posts nothing more (idempotent)", async () => {
  const gh = stubGithubComments();
  const rows = [{ ...ROW, pr_linked_pr_key: "owner/repo#101" }];
  const { app, claimAttempts } = fakeApp(rows);
  try {
    await handler(
      { jobKey: "j3", variables: { featureKey: "owner/repo#7", status: "opened", pr: "owner/repo#101", claimIssue: true } } as never,
      app,
    );
    assertEquals(gh.posted.length, 0, "no duplicate comment");
    assertEquals(claimAttempts.length, 0, "the recorded link short-circuited before any GitHub read");
  } finally {
    gh.restore();
  }
});

test("an epic slice (claimIssue unset) posts NOTHING on its parent epic", async () => {
  const gh = stubGithubComments();
  const rows = [{ ...ROW }];
  const { app, claimAttempts } = fakeApp(rows);
  try {
    await handler(
      { jobKey: "j4", variables: { featureKey: "owner/repo#7", status: "opened", pr: "owner/repo#101" } } as never,
      app,
    );
    assertEquals(gh.posted.length, 0, "no comment was posted");
    assertEquals(claimAttempts.length, 0, "no link was claimed");
  } finally {
    gh.restore();
  }
});

test("a blocked run posts nothing", async () => {
  const gh = stubGithubComments();
  const rows = [{ ...ROW }];
  const { app } = fakeApp(rows);
  try {
    const out = await handler(
      { jobKey: "j5", variables: { featureKey: "owner/repo#7", status: "blocked", claimIssue: true } } as never,
      app,
    );
    assertEquals(out.featureStatus, "blocked");
    assertEquals(gh.posted.length, 0);
  } finally {
    gh.restore();
  }
});

test("a failed comment POST never fails the job — the run still records opened", async () => {
  const gh = stubGithubComments([], { failPost: true });
  const rows = [{ ...ROW }];
  const { app } = fakeApp(rows);
  try {
    const out = await handler(
      { jobKey: "j6", variables: { featureKey: "owner/repo#7", status: "opened", pr: "owner/repo#101", claimIssue: true } } as never,
      app,
    );
    assertEquals(out.featureStatus, "opened", "the job completed normally");
    assertEquals(rows[0].status, "opened", "the run row was still recorded");
    assertEquals(rows[0].pr_key, "owner/repo#101");
  } finally {
    gh.restore();
  }
});
