// Unit tests for the transient merge-race classification (issue #334).
//
// #334: a GitHub-flagged *retryable* merge race — the base (or head) branch advanced between the
// mergeability read and the merge mutation, so GitHub aborted with "… try the merge again" — was
// misclassified by `mergePr`'s catch-all as `blocked`, producing a misleading human escalation on
// a PR that was actually mergeable once the base settled. The fix classifies the stable
// base/head-moved messages as a new `retry` outcome (the merge loop re-attempts on the settled
// base), while every genuine block (conflict / failing check / 403 perms / 422 not-mergeable)
// stays `blocked`. These tests pin that split so a real block is never swallowed as transient.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { isTransientMergeRace, mergePr } from "./github.ts";

test("isTransientMergeRace: the base/head-moved races are transient", () => {
  // GraphQL mergePullRequest error (observed live on nano-workforce #330).
  assertEquals(
    isTransientMergeRace(
      "GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)",
    ),
    true,
  );
  // The head-branch-moved sibling.
  assertEquals(
    isTransientMergeRace("Head branch was modified. Review and try the merge again."),
    true,
  );
  // The HTTP 405 REST variant.
  assertEquals(
    isTransientMergeRace(
      "github 405 Method Not Allowed: Base branch was modified. Review and try the merge again.",
    ),
    true,
  );
});

test("isTransientMergeRace: genuine blocks are NOT transient (never swallowed)", () => {
  assertEquals(isTransientMergeRace("Pull Request is not mergeable"), false); // conflict / failing check
  assertEquals(isTransientMergeRace("github 403 Forbidden: Resource not accessible"), false); // perms
  assertEquals(
    isTransientMergeRace("github 422 Unprocessable Entity: Required status check is expected"),
    false,
  ); // not-mergeable gate
  assertEquals(isTransientMergeRace("Merge conflict; base branch has conflicts"), false); // a base conflict is a real block
});

// Drive `mergePr`'s REST (token) transport: the 405 base-moved race must surface as `retry`, while
// a genuine 405 refusal stays `blocked`.
async function withMergePut(
  status: number,
  statusText: string,
  body: string,
  run: () => Promise<void>,
): Promise<void> {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevFetch = globalThis.fetch;
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (/\/pulls\/\d+\/merge$/.test(url) && (init?.method ?? "").toUpperCase() === "PUT") {
      return Promise.resolve(new Response(body, { status, statusText }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = prevFetch;
    if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
  }
}

test("mergePr: a 405 base-moved race → outcome 'retry'", async () => {
  await withMergePut(
    405,
    "Method Not Allowed",
    "Base branch was modified. Review and try the merge again.",
    async () => {
      const res = await mergePr("acme/widgets", 42, "test-token", { method: "squash", admin: false });
      assertEquals(res?.outcome, "retry");
    },
  );
});

test("mergePr: a genuine 405 refusal → outcome 'blocked' (not swallowed as transient)", async () => {
  await withMergePut(405, "Method Not Allowed", "Pull Request is not mergeable", async () => {
    const res = await mergePr("acme/widgets", 42, "test-token", { method: "squash", admin: false });
    assertEquals(res?.outcome, "blocked");
  });
});
