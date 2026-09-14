import assert from "node:assert/strict";
import { test } from "node:test";
import { makeHandler } from "./worker.ts";

const assertEquals = (a: unknown, b: unknown, m?: string) => assert.deepStrictEqual(a, b, m);

// The worker reads only `job.variables`, so a bare stub job suffices.
const job = (variables: Record<string, unknown>) => ({ variables }) as never;

test("capture-head: reads the head via the carried repo/prNumber and publishes it as roundEntryHead", async () => {
  let seen: [string, number] | null = null;
  const handler = makeHandler({
    readHead: async (repo, n) => {
      seen = [repo, n];
      return "sha-abc";
    },
  });
  const out = await handler(job({ prKey: "o/r#1", repo: "o/r", prNumber: 1 }), {} as never);
  assertEquals(out, { roundEntryHead: "sha-abc" });
  assertEquals(seen, ["o/r", 1], "the carried repo/prNumber drive the head read");
});

test("capture-head: falls back to parsing the prKey when repo/prNumber are absent", async () => {
  let seen: [string, number] | null = null;
  const handler = makeHandler({
    readHead: async (repo, n) => {
      seen = [repo, n];
      return "sha-def";
    },
  });
  const out = await handler(job({ prKey: "owner/repo#42" }), {} as never);
  assertEquals(out, { roundEntryHead: "sha-def" });
  assertEquals(seen, ["owner/repo", 42], "repo/prNumber resolved from the canonical prKey");
});

test("capture-head: an unreadable head fails OPEN to the empty-string sentinel (never a fabricated baseline)", async () => {
  // A transient GitHub hiccup must never publish a wrong baseline. The empty string is the "unknown"
  // sentinel progress-check treats as no round-entry baseline (→ it falls back to last_round_head).
  const handler = makeHandler({ readHead: async () => null });
  const out = await handler(job({ prKey: "o/r#1", repo: "o/r", prNumber: 1 }), {} as never);
  assertEquals(out, { roundEntryHead: "" });
});

test("capture-head: a THROWING head read is swallowed to the empty-string sentinel", async () => {
  const handler = makeHandler({
    readHead: async () => {
      throw new Error("network down");
    },
  });
  const out = await handler(job({ prKey: "o/r#1", repo: "o/r", prNumber: 1 }), {} as never);
  assertEquals(out, { roundEntryHead: "" });
});

test("capture-head: an unresolvable target (unparseable prKey, no repo/prNumber) publishes the empty sentinel without calling the reader", async () => {
  let called = false;
  const handler = makeHandler({
    readHead: async () => {
      called = true;
      return "sha-x";
    },
  });
  const out = await handler(job({ prKey: "not-a-pr-key" }), {} as never);
  assertEquals(out, { roundEntryHead: "" });
  assertEquals(called, false, "no target ⇒ the head reader is never invoked");
});

test("capture-head: always publishes roundEntryHead so a husk retry / new round OVERWRITES a prior entry SHA", async () => {
  // The field is returned on every invocation (string or ""), so a re-entry never carries a stale
  // captured head forward — the value is re-derived from the live head each round entry.
  const heads = ["sha-1", "sha-2"];
  let i = 0;
  const handler = makeHandler({ readHead: async () => heads[i++] ?? null });
  const first = await handler(job({ prKey: "o/r#1", repo: "o/r", prNumber: 1 }), {} as never);
  const second = await handler(job({ prKey: "o/r#1", repo: "o/r", prNumber: 1 }), {} as never);
  assertEquals(first, { roundEntryHead: "sha-1" });
  assertEquals(second, { roundEntryHead: "sha-2" }, "the re-entry overwrites with a freshly-read head");
});
