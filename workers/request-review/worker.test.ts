// pr.request-review (issue #939): the merge loop requests a head-current Copilot review itself, and
// re-triggers a silently-ignored request (withdraw + re-add) on a re-request.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { noopLog } from "../../test/log.ts";
import { makeHandler, type ReviewRequestOps } from "./worker.ts";

function fakeApp() {
  const merges: Record<string, unknown>[] = [];
  return {
    merges,
    app: {
      data: { table: () => ({ insert: (r: Record<string, unknown>) => (merges.push(r), Promise.resolve(1)) }) },
      log: noopLog(),
    } as any,
  };
}

function ops(over: Partial<ReviewRequestOps>, calls: string[]): ReviewRequestOps {
  return {
    hasPending: async () => (calls.push("pending?"), false),
    remove: async () => calls.push("remove"),
    request: async () => (calls.push("request"), "requested"),
    ...over,
  };
}

const job = (round: number) => ({ variables: { prKey: "acme/w#1", repo: "acme/w", prNumber: 1, reviewRequestRound: round } }) as any;

test("first request POSTs the Copilot reviewer and audits it", async () => {
  const calls: string[] = [];
  const { app, merges } = fakeApp();
  const out = await makeHandler(ops({}, calls))(job(0), app);
  assertEquals(out, { reviewRequest: "requested" });
  assertEquals(calls, ["request"]);
  assertEquals(merges[0].outcome, "review-requested");
});

test("a re-request with Copilot still pending (silently ignored) withdraws then re-adds", async () => {
  const calls: string[] = [];
  const { app } = fakeApp();
  await makeHandler(ops({ hasPending: async () => (calls.push("pending?"), true) }, calls))(job(1), app);
  assertEquals(calls, ["pending?", "remove", "request"]);
});

test("Copilot not assignable reports unavailable; a transport error reports failed (never throws)", async () => {
  const { app } = fakeApp();
  assertEquals(await makeHandler(ops({ request: async () => "unavailable" }, []))(job(0), app), { reviewRequest: "unavailable" });
  assertEquals(
    await makeHandler(ops({ request: async () => { throw new Error("502"); } }, []))(job(0), app),
    { reviewRequest: "failed" },
  );
  assertEquals(await makeHandler(ops({ request: async () => null }, []))(job(0), app), { reviewRequest: "failed" });
});
