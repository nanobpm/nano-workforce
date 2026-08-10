// Unit tests for `fetchPrFiles` token-transport paging (issue #58): the D2 conflict-scan must get
// a COMPLETE file list or a thrown error — never a silently truncated one that under-approximates
// the merge-exclusion graph. Force the token transport and stub `globalThis.fetch`.
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { fetchPrFiles } from "./github.ts";

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
  const prevMode = Deno.env.get("NANO_PR_GITHUB_TRANSPORT");
  const prevFetch = globalThis.fetch;
  Deno.env.set("NANO_PR_GITHUB_TRANSPORT", "token");
  globalThis.fetch = stubFetch(pages) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prevFetch;
    if (prevMode === undefined) Deno.env.delete("NANO_PR_GITHUB_TRANSPORT");
    else Deno.env.set("NANO_PR_GITHUB_TRANSPORT", prevMode);
  }
}

Deno.test("fetchPrFiles: returns the complete list for a sub-cap PR (short final page)", async () => {
  const files = await withTokenTransport([100, 42], () => fetchPrFiles("o/r", 1, "tok"));
  assertEquals(files?.length, 142);
});

Deno.test("fetchPrFiles: exactly 500 files with no next page is complete, not truncated", async () => {
  // 5 full pages, but no `rel="next"` on the last → the list is exactly complete at the cap.
  const files = await withTokenTransport([100, 100, 100, 100, 100], () => fetchPrFiles("o/r", 2, "tok"));
  assertEquals(files?.length, 500);
});

Deno.test("fetchPrFiles: throws when the cap genuinely truncates (full last page + next)", async () => {
  // 6 pages available but only 5 fetched → the 5th page still advertises `rel="next"`.
  await assertRejects(
    () => withTokenTransport([100, 100, 100, 100, 100, 100], () => fetchPrFiles("o/r", 3, "tok")),
    Error,
    "truncated",
  );
});
