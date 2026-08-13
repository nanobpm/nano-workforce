// Unit tests for `fetchPrFiles` token-transport paging (issue #58): the D2 conflict-scan must get
// a COMPLETE file list or a thrown error — never a silently truncated one that under-approximates
// the merge-exclusion graph. Force the token transport and stub `globalThis.fetch`.
import { test } from "node:test";
import { assertEquals, assertRejects } from "#test-assert";
import { fetchPrFiles, openPullRequest } from "./github.ts";

// A fake `fetch` that serves `pages` of file batches; each page N (1-based) returns `pages[N-1]`
// files (named `f{index}`), setting a `Link: rel="next"` header whenever a later page exists.
function stubFetch(pages: number[]) {
  const total = pages.reduce((a, b) => a + b, 0);
  return (url: string | URL | Request): Promise<Response> => {
    const u = new URL(String(url));
    const page = Number(u.searchParams.get("page") ?? "1");
    const count = pages[page - 1] ?? 0;
    const start = pages.slice(0, page - 1).reduce((a, b) => a + b, 0);
    const body = Array.from({ length: count }, (_, i) => ({ filename: `f${start + i}` }));
    const headers = new Headers();
    if (page < pages.length) {
      headers.set("link", `<https://api.github.com/next?page=${page + 1}>; rel="next"`);
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers }),
    );
  };
}

async function withTokenTransport<T>(pages: number[], fn: () => Promise<T>): Promise<T> {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevFetch = globalThis.fetch;
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  globalThis.fetch = stubFetch(pages) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prevFetch;
    if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
  }
}

test("fetchPrFiles: returns the complete list for a sub-cap PR (short final page)", async () => {
  const files = await withTokenTransport([100, 42], () => fetchPrFiles("o/r", 1, "tok"));
  assertEquals(files?.length, 142);
});

test("fetchPrFiles: exactly 500 files with no next page is complete, not truncated", async () => {
  // 5 full pages, but no `rel="next"` on the last → the list is exactly complete at the cap.
  const files = await withTokenTransport([100, 100, 100, 100, 100], () => fetchPrFiles("o/r", 2, "tok"));
  assertEquals(files?.length, 500);
});

test("fetchPrFiles: throws when the cap genuinely truncates (full last page + next)", async () => {
  // 6 pages available but only 5 fetched → the 5th page still advertises `rel="next"`.
  await assertRejects(
    () => withTokenTransport([100, 100, 100, 100, 100, 100], () => fetchPrFiles("o/r", 3, "tok")),
    Error,
    "truncated",
  );
});

// ── openPullRequest (epic promotion — issue #160) ───────────────────────────
// The promote operation branches on the discriminated result, so the two GitHub 4xx cases it
// cares about (a PR already exists for head/base; an invalid base/head) must be surfaced as
// distinct outcomes, not thrown. Force the token transport and stub `globalThis.fetch`.

function withStubbedFetch<T>(
  stub: (url: string, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<T>,
): Promise<T> {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevFetch = globalThis.fetch;
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
    stub(String(url), init)) as typeof fetch;
  return (async () => {
    try {
      return await fn();
    } finally {
      globalThis.fetch = prevFetch;
      if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
      else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
    }
  })();
}

test("openPullRequest: happy path returns the created PR url and number", async () => {
  const res = await withStubbedFetch(
    (url, init) => {
      assertEquals(url, "https://api.github.com/repos/o/r/pulls");
      assertEquals(init?.method, "POST");
      const body = JSON.parse(String(init?.body));
      assertEquals(body, { title: "T", head: "feat/x", base: "epic/y", body: "B" });
      return Promise.resolve(
        new Response(JSON.stringify({ html_url: "https://github.com/o/r/pull/456", number: 456 }), {
          status: 201,
        }),
      );
    },
    () => openPullRequest("o/r", "epic/y", "feat/x", "T", "B", "tok"),
  );
  assertEquals(res, { outcome: "opened", url: "https://github.com/o/r/pull/456", number: 456 });
});

test("openPullRequest: a 422 'already exists' is surfaced as outcome 'exists', not thrown", async () => {
  const res = await withStubbedFetch(
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            message: "Validation Failed",
            errors: [{ message: "A pull request already exists for o:feat/x." }],
          }),
          { status: 422 },
        ),
      ),
    () => openPullRequest("o/r", "epic/y", "feat/x", "T", "B", "tok"),
  );
  assertEquals(res?.outcome, "exists");
});

test("openPullRequest: an invalid base/head (422) is surfaced as outcome 'invalid'", async () => {
  const res = await withStubbedFetch(
    () =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "Validation Failed: field base is invalid" }), {
          status: 422,
        }),
      ),
    () => openPullRequest("o/r", "nope", "feat/x", "T", "B", "tok"),
  );
  assertEquals(res?.outcome, "invalid");
});

test("openPullRequest: a genuine transport failure (5xx) propagates as a throw", async () => {
  await assertRejects(
    () =>
      withStubbedFetch(
        () => Promise.resolve(new Response("boom", { status: 500, statusText: "Server Error" })),
        () => openPullRequest("o/r", "epic/y", "feat/x", "T", "B", "tok"),
      ),
    Error,
    "500",
  );
});
