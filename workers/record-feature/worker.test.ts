// Unit coverage for pr.record-feature's "PR opened" issue link (issue #907).
//
// record-feature is the ONE point every PR-delivering path of a single-issue feature run passes
// through — the agent's own `opened`, a retry's `opened`, and the reconcile step's ADOPTED `opened`
// all land here — so it is the canonical host-side writer of the idempotent
// `🤖 Pull request opened: #n` comment on the claimed issue. The decision itself lives in
// app/issuePrLink.ts (exhaustively covered in app/issuePrLink.test.ts); these tests pin the
// WIRING: the worker records the owed link + attempts it only for a claimed (single-issue) run
// that delivered a keyed PR, the comment targets the CLAIMED issue (the run row's repo +
// issue_number, not the PR's repository), and a failed comment never fails the job.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { noopLog } from "../../test/log.ts";
import handler from "./worker.ts";

// biome-ignore lint/suspicious/noExplicitAny: tiny in-memory app double, mirrors record-feature-implementing.worker.test
function fakeApp(rows: Record<string, unknown>[]): { app: any; linkWrites: string[] } {
  const stores: Record<string, Record<string, unknown>[]> = { feature_runs: rows };
  const linkWrites: string[] = [];
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
              linkWrites.push(sql);
              // Mirror the issue-link state machine's SQL on the in-memory row so the link record
              // is observable: the owed write, the lease CAS, and the confirm.
              const row = stores.feature_runs[0];
              if (!row) return { changed: 0 };
              if (/SET "pr_link_want_pr_key" = \?/.test(sql)) {
                row.pr_link_want_pr_key = String(params[0]);
                return { changed: 1 };
              }
              if (/SET "pr_link_lease_at" = \?/.test(sql)) {
                row.pr_link_lease_at = String(params[0]);
                return { changed: 1 };
              }
              if (/SET "pr_linked_pr_key" = \?, "pr_link_lease_at" = NULL/.test(sql)) {
                row.pr_linked_pr_key = String(params[0]);
                row.pr_link_lease_at = null;
                return { changed: 1 };
              }
              return { changed: 0 };
            },
          };
        },
      },
      log: noopLog(),
    },
    linkWrites,
  };
}

/** Hermetic GitHub stub (token transport + fetch double) capturing posted comment bodies and the
 *  path of every call (so a test can pin WHICH repo/issue a comment or title read targeted). */
function stubGithubComments(existing: { body: string }[] = [], opts: { failPost?: boolean } = {}) {
  const prevTransport = process.env.NANO_PR_GITHUB_TRANSPORT;
  const prevToken = process.env.GITHUB_TOKEN;
  const prevFetch = globalThis.fetch;
  process.env.NANO_PR_GITHUB_TRANSPORT = "token";
  process.env.GITHUB_TOKEN = "t";
  const posted: string[] = [];
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const u = new URL(String(url));
    calls.push(`${method} ${u.pathname}`);
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
    calls,
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
    assertEquals(rows[0].pr_link_want_pr_key, "owner/repo#101", "the owed link was recorded");
    assertEquals(rows[0].pr_linked_pr_key, "owner/repo#101", "the durable link was confirmed");
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

test("a CROSS-REPO PR comments on the CLAIMED issue (the run row's repo + issue_number), not the PR's repo", async () => {
  // Regression for the review finding: the old worker derived the comment target from the PR's
  // repository + the issue NUMBER, so a run for owner/issues#7 delivering owner/code#101 commented
  // on owner/code#7 (or 404'd). The target must come from the run row; the PR repo is used only
  // for the title lookup.
  const gh = stubGithubComments();
  const rows = [{ feature_key: "owner/issues#7", repo: "owner/issues", issue_number: 7, status: "running" }];
  const { app } = fakeApp(rows);
  try {
    const out = await handler(
      { jobKey: "j2x", variables: { featureKey: "owner/issues#7", status: "opened", pr: "owner/code#101", claimIssue: true } } as never,
      app,
    );
    assertEquals(out.prKey, "owner/code#101");
    assertEquals(gh.posted.length, 1, "the claimed issue got the PR-opened comment");
    assert(
      gh.calls.some((c) => c === "POST /repos/owner/issues/issues/7/comments"),
      `the comment landed on the claimed issue owner/issues#7 (calls: ${gh.calls.join(", ")})`,
    );
    assert(
      gh.calls.some((c) => c === "GET /repos/owner/code/pulls/101"),
      "the PR title was read from the PR's OWN repository",
    );
    assert(
      !gh.calls.some((c) => c.includes("/repos/owner/code/issues/")),
      "the PR repository's issues were never targeted",
    );
    assert(gh.posted[0].includes("https://github.com/owner/code/pull/101"), "the comment links the cross-repo PR");
  } finally {
    gh.restore();
  }
});

test("a repeated record pass for the SAME PR posts nothing more (idempotent)", async () => {
  const gh = stubGithubComments();
  const rows = [{ ...ROW, pr_link_want_pr_key: "owner/repo#101", pr_linked_pr_key: "owner/repo#101" }];
  const { app, linkWrites } = fakeApp(rows);
  try {
    await handler(
      { jobKey: "j3", variables: { featureKey: "owner/repo#7", status: "opened", pr: "owner/repo#101", claimIssue: true } } as never,
      app,
    );
    assertEquals(gh.posted.length, 0, "no duplicate comment");
    assert(
      !linkWrites.some((sql) => /SET "pr_link_lease_at"/.test(sql)),
      "the confirmed link short-circuited before the lease CAS (and before any GitHub read)",
    );
  } finally {
    gh.restore();
  }
});

test("an epic slice (claimIssue unset) posts NOTHING on its parent epic", async () => {
  const gh = stubGithubComments();
  const rows = [{ ...ROW }];
  const { app, linkWrites } = fakeApp(rows);
  try {
    await handler(
      { jobKey: "j4", variables: { featureKey: "owner/repo#7", status: "opened", pr: "owner/repo#101" } } as never,
      app,
    );
    assertEquals(gh.posted.length, 0, "no comment was posted");
    assertEquals(linkWrites.length, 0, "no link state was written");
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
