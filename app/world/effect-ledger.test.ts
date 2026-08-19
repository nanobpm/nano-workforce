// Tests for the effect ledger + fence (issue #324, ADR 0062 Slice 4/5, the WORLD half). The fence is
// the guarantee behind the acceptance criterion "no duplicate push/comment (fence holds)": on a
// resume the post-checkpoint effect tail is replayed, and an already-applied effect must be SKIPPED,
// never re-executed. These prove the pure fold in isolation (no DB, no git).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { type Effect, type Fence, fenceReplay } from "./effect-ledger.ts";

/** An in-memory fence over a `Set` of applied idempotency keys. */
function memFence(applied: string[] = []): Fence & { keys: Set<string> } {
  const keys = new Set(applied);
  return {
    keys,
    isApplied: (k: string) => keys.has(k),
    markApplied: (e: Effect) => {
      keys.add(e.idempotencyKey);
    },
  };
}

const push = (sha: string): Effect => ({ kind: "push", idempotencyKey: sha });
const comment = (id: string): Effect => ({ kind: "pr-comment", idempotencyKey: id });

test("fenceReplay skips an already-applied effect and never re-applies it (the fence holds)", async () => {
  const fence = memFence(["sha-1", "comment-9"]);
  const applied: string[] = [];
  const outcome = await fenceReplay([push("sha-1"), comment("comment-9")], fence, (e) => {
    applied.push(e.idempotencyKey);
  });
  assertEquals(applied, [], "no effect is re-applied — both were already in the fence");
  assertEquals(
    outcome.skipped.map((e) => e.idempotencyKey),
    ["sha-1", "comment-9"],
    "both effects are reported skipped",
  );
  assertEquals(outcome.applied.length, 0);
});

test("fenceReplay applies only the genuinely-missing tail effect (crash after push, before comment)", async () => {
  // The replacement activation crashed after the push landed but before its trailing comment: the
  // push is fenced, the comment is not. Only the comment must replay.
  const fence = memFence(["sha-1"]);
  const applied: string[] = [];
  const outcome = await fenceReplay([push("sha-1"), comment("comment-9")], fence, (e) => {
    applied.push(e.idempotencyKey);
  });
  assertEquals(applied, ["comment-9"], "only the missing comment is applied");
  assertEquals(outcome.applied.map((e) => e.idempotencyKey), ["comment-9"]);
  assertEquals(outcome.skipped.map((e) => e.idempotencyKey), ["sha-1"]);
  assert(fence.keys.has("comment-9"), "the applied effect is now recorded so a later resume skips it");
});

test("fenceReplay applies effects strictly in order (a comment referencing a push never precedes it)", async () => {
  const fence = memFence();
  const order: string[] = [];
  await fenceReplay([push("sha-1"), comment("c-1"), comment("c-2")], fence, (e) => {
    order.push(e.idempotencyKey);
  });
  assertEquals(order, ["sha-1", "c-1", "c-2"], "the fold preserves recorded order");
});

test("fenceReplay collapses a duplicate idempotency key within one tail to a single apply", async () => {
  // Two ledger entries with one key denote ONE real effect; the second is always a skip even before
  // the durable fence sees it (a malformed tail must not double-apply).
  const fence = memFence();
  const applied: string[] = [];
  const outcome = await fenceReplay([comment("c-1"), comment("c-1")], fence, (e) => {
    applied.push(e.idempotencyKey);
  });
  assertEquals(applied, ["c-1"], "the effect is applied exactly once");
  assertEquals(outcome.skipped.length, 1, "the duplicate is skipped");
});

test("a second replay of the same tail is a total no-op — idempotent resume", async () => {
  const fence = memFence();
  const tail = [push("sha-1"), comment("c-1")];
  const applyCount = { n: 0 };
  await fenceReplay(tail, fence, () => {
    applyCount.n++;
  });
  assertEquals(applyCount.n, 2, "first replay applies both");
  await fenceReplay(tail, fence, () => {
    applyCount.n++;
  });
  assertEquals(applyCount.n, 2, "second replay applies nothing — the fence holds across resumes");
});
