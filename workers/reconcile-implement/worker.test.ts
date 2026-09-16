// Unit coverage for pr.reconcile-implement — the implement-cell's reconcile-before-escalate step
// (issue #801). It wraps the canonical `reconcileImplement` decision with the injected GitHub read;
// here we assert the handler wires job variables through and re-emits the decision (the gate variable
// `reconciled` plus the adopted `status`/`pr`). The decision logic itself is exhaustively covered in
// app/implementReconcile.test.ts.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { noopLog } from "../../test/log.ts";
import handler from "./worker.ts";

// biome-ignore lint/suspicious/noExplicitAny: tiny app double — the handler only touches app.log.
const fakeApp: any = { log: noopLog() };

test("adopts an open PR on the branch: emits reconciled + status=opened + pr", async () => {
  const prevToken = process.env.GITHUB_TOKEN;
  const prevTransport = process.env.NANO_PR_GITHUB_TRANSPORT;
  const prevFetch = globalThis.fetch;
  process.env.GITHUB_TOKEN = "t";
  process.env.NANO_PR_GITHUB_TRANSPORT = "token";
  // Token transport (never shells out to `gh`): stub the pulls listing so `listPrsForHead` returns one
  // open PR opened from `feat/issue-801`.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify([{ number: 801, html_url: "https://github.com/owner/repo/pull/801", state: "open", base: { ref: "main" } }]), {
      status: 200,
    })) as typeof fetch;
  try {
    const out = await handler(
      { jobKey: "j1", variables: { subjectKey: "owner/repo#801", task: { id: "issue-801" }, status: null } } as never,
      fakeApp,
    );
    assertEquals(out, { reconciled: true, status: "opened", pr: "owner/repo#801" });
  } finally {
    globalThis.fetch = prevFetch;
    if (prevToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prevToken;
    if (prevTransport === undefined) delete process.env.NANO_PR_GITHUB_TRANSPORT;
    else process.env.NANO_PR_GITHUB_TRANSPORT = prevTransport;
  }
});

test("no open PR on the branch: falls through to escalate (reconciled=false)", async () => {
  const prevToken = process.env.GITHUB_TOKEN;
  const prevTransport = process.env.NANO_PR_GITHUB_TRANSPORT;
  const prevFetch = globalThis.fetch;
  process.env.GITHUB_TOKEN = "t";
  process.env.NANO_PR_GITHUB_TRANSPORT = "token";
  globalThis.fetch = (async () => new Response(JSON.stringify([]), { status: 200 })) as typeof fetch;
  try {
    const out = await handler(
      { jobKey: "j2", variables: { subjectKey: "owner/repo#7", task: { id: "issue-7" }, status: null } } as never,
      fakeApp,
    );
    assertEquals(out, { reconciled: false, status: null, pr: null });
  } finally {
    globalThis.fetch = prevFetch;
    if (prevToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prevToken;
    if (prevTransport === undefined) delete process.env.NANO_PR_GITHUB_TRANSPORT;
    else process.env.NANO_PR_GITHUB_TRANSPORT = prevTransport;
  }
});
