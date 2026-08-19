// Tests for the durable world store (issue #324, ADR 0062 Slice 4/5) against a REAL in-memory SQLite
// engine with migration 049 applied — so the monotonic checkpoint offset, the effect-tail ordering,
// and the durable fence (`UNIQUE(pr_key, idempotency_key)` → `isApplied`/`markApplied`) are proven,
// not mocked.
import { test } from "node:test";
import { assert, assertEquals, assertRejects } from "#test-assert";
import { memWorldData } from "../../test/worldDb.ts";
import type { Effect } from "./effect-ledger.ts";
import { WorldStore } from "./store.ts";

const PR = "o/r#1";
const push = (sha: string): Effect => ({ kind: "push", idempotencyKey: sha });

test("nextOffset is a per-PR monotonic counter derived from the durable rows", async () => {
  const { data } = memWorldData();
  const store = new WorldStore(data);
  assertEquals(await store.nextOffset(PR), 0, "first checkpoint is offset 0");
  await store.recordCheckpoint({ prKey: PR, roundNo: 1, commitSha: "sha-a" });
  assertEquals(await store.nextOffset(PR), 1, "second is offset 1");
  await store.recordCheckpoint({ prKey: PR, roundNo: 2, commitSha: "sha-b" });
  assertEquals(await store.nextOffset(PR), 2);
  // A different PR has its own independent counter.
  assertEquals(await store.nextOffset("o/r#2"), 0, "offsets are scoped per PR");
});

test("lastCheckpoint returns the newest push-checkpoint (max offset), or null when none", async () => {
  const { data } = memWorldData();
  const store = new WorldStore(data);
  assertEquals(await store.lastCheckpoint(PR), null, "no checkpoint yet — nothing to reconstruct");
  await store.recordCheckpoint({ prKey: PR, roundNo: 1, commitSha: "sha-a" });
  await store.recordCheckpoint({ prKey: PR, roundNo: 2, commitSha: "sha-b" });
  const last = await store.lastCheckpoint(PR);
  assertEquals(last, { offset: 1, commitSha: "sha-b", roundNo: 2 }, "the newest checkpoint wins");
});

test("recordCheckpoint defaults to a single push effect keyed by the commit SHA", async () => {
  const { data } = memWorldData();
  const store = new WorldStore(data);
  const offset = await store.recordCheckpoint({ prKey: PR, roundNo: 1, commitSha: "sha-a" });
  const tail = await store.effectTail(PR, offset);
  assertEquals(tail, [{ kind: "push", idempotencyKey: "sha-a" }], "the push itself is the default effect");
});

test("effectTail returns the recorded effects in seq order", async () => {
  const { data } = memWorldData();
  const store = new WorldStore(data);
  const effects: Effect[] = [
    push("sha-a"),
    { kind: "pr-comment", idempotencyKey: "c-1", description: "first" },
    { kind: "merge", idempotencyKey: "m-1" },
  ];
  const offset = await store.recordCheckpoint({ prKey: PR, roundNo: 1, commitSha: "sha-a", effects });
  const tail = await store.effectTail(PR, offset);
  assertEquals(tail.map((e) => e.idempotencyKey), ["sha-a", "c-1", "m-1"], "order is preserved");
  assertEquals(tail[1].description, "first", "the audit description round-trips");
});

test("the durable fence: a re-recorded idempotency key is not a second effect row", async () => {
  const { data } = memWorldData();
  const store = new WorldStore(data);
  await store.recordCheckpoint({ prKey: PR, roundNo: 1, commitSha: "sha-a", effects: [push("sha-a")] });
  // Re-record the SAME push (a duplicate persist-round) — the UNIQUE fence collapses it.
  await store.recordCheckpoint({ prKey: PR, roundNo: 2, commitSha: "sha-a", effects: [push("sha-a")] });
  const rows = await data.table("world_effects", "id").find({ pr_key: PR, idempotency_key: "sha-a" });
  assertEquals(rows.length, 1, "one real effect → exactly one ledger row, despite two records");
});

test("recordCheckpoint is idempotent on the commit SHA: a re-record reuses the offset, never orphaning a pending tail", async () => {
  const { data } = memWorldData();
  const store = new WorldStore(data);
  // Round records a checkpoint at a push with a PENDING tail effect (recorded before it is performed).
  const first = await store.recordCheckpoint({
    prKey: PR,
    roundNo: 1,
    commitSha: "sha-a",
    effects: [push("sha-a"), { kind: "pr-comment", idempotencyKey: "c-1" }],
    applied: false,
  });
  assertEquals(first, 0, "first checkpoint is offset 0");
  // A retried/duplicate persist-round records the SAME {prKey, commitSha}. A naive impl allocates a
  // fresh offset whose tail is empty (the global fence skips the already-recorded effects), making it
  // the newest checkpoint and orphaning the genuinely-pending "c-1" effect on offset 0 — silent loss.
  const second = await store.recordCheckpoint({
    prKey: PR,
    roundNo: 2,
    commitSha: "sha-a",
    effects: [push("sha-a"), { kind: "pr-comment", idempotencyKey: "c-1" }],
    applied: false,
  });
  assertEquals(second, 0, "the re-record REUSES the existing offset, not a new one");
  const last = await store.lastCheckpoint(PR);
  assertEquals(last?.offset, 0, "the newest checkpoint is still the one carrying the pending tail");
  const tail = await store.effectTail(PR, last?.offset ?? -1);
  assertEquals(
    tail.map((e) => e.idempotencyKey),
    ["sha-a", "c-1"],
    "the pending tail survives on the surviving checkpoint — no orphaned/ignored pending effect",
  );
  const cps = await data.table("world_checkpoints", "id").find({ pr_key: PR });
  assertEquals(cps.length, 1, "exactly one checkpoint row for the SHA, despite two records");
});

test("recordCheckpoint reusing an offset appends a newly-supplied effect after the existing tail", async () => {
  const { data } = memWorldData();
  const store = new WorldStore(data);
  await store.recordCheckpoint({ prKey: PR, roundNo: 1, commitSha: "sha-a", effects: [push("sha-a")] });
  // Same SHA re-recorded, now carrying an ADDITIONAL effect (e.g. a PR comment made after the push).
  const offset = await store.recordCheckpoint({
    prKey: PR,
    roundNo: 1,
    commitSha: "sha-a",
    effects: [push("sha-a"), { kind: "pr-comment", idempotencyKey: "c-2" }],
  });
  const tail = await store.effectTail(PR, offset);
  assertEquals(
    tail.map((e) => e.idempotencyKey),
    ["sha-a", "c-2"],
    "the new effect is appended after the existing tail on the reused offset, in seq order",
  );
});

test("fenceFor.isApplied is true only once an effect is recorded AND applied; markApplied flips it", async () => {
  const { data } = memWorldData();
  const store = new WorldStore(data);
  // Record a PENDING tail effect (applied=false) — recorded before it is performed.
  await store.recordCheckpoint({
    prKey: PR,
    roundNo: 1,
    commitSha: "sha-a",
    effects: [{ kind: "pr-comment", idempotencyKey: "c-1" }],
    applied: false,
  });
  const fence = store.fenceFor(PR, 0);
  assertEquals(await fence.isApplied("c-1"), false, "a pending effect is NOT yet applied");
  assertEquals(await fence.isApplied("absent"), false, "an unknown key is not applied");
  await fence.markApplied({ kind: "pr-comment", idempotencyKey: "c-1" });
  assertEquals(await fence.isApplied("c-1"), true, "markApplied realises it so a later resume skips");
});

test("fenceFor.markApplied records a brand-new applied effect when the key is absent", async () => {
  const { data } = memWorldData();
  const store = new WorldStore(data);
  await store.recordCheckpoint({ prKey: PR, roundNo: 1, commitSha: "sha-a" });
  const fence = store.fenceFor(PR, 0);
  await fence.markApplied({ kind: "merge", idempotencyKey: "m-1" });
  assert(await fence.isApplied("m-1"), "a newly-applied effect is now fenced");
});

test("recordCheckpoint is atomic: a mid-write effect failure rolls back the checkpoint row too", async () => {
  const { data, db } = memWorldData();
  // Decorate the transaction-scoped data source so the SECOND `world_effects` insert throws — a crash
  // AFTER the checkpoint row + first effect but BEFORE the second. Without an enclosing transaction
  // this leaves a checkpoint whose fence is missing ledger rows; the atomic write must roll it ALL back.
  const realOpen = (data as unknown as { open: () => Record<string, unknown> }).open.bind(data);
  (data as unknown as { open: () => Record<string, unknown> }).open = () => {
    const ds = realOpen();
    const realTable = (ds.table as (name: string, pk?: string) => Record<string, unknown>).bind(ds);
    let effectInserts = 0;
    ds.table = (name: string, pk?: string) => {
      const t = realTable(name, pk);
      if (name === "world_effects") {
        const realInsert = (t.insert as (row: unknown) => Promise<number>).bind(t);
        t.insert = async (row: unknown) => {
          if (++effectInserts === 2) throw new Error("simulated crash mid-append");
          return realInsert(row);
        };
      }
      return t;
    };
    return ds;
  };
  const store = new WorldStore(data);
  await assertRejects(
    () =>
      store.recordCheckpoint({
        prKey: PR,
        roundNo: 1,
        commitSha: "sha-a",
        effects: [
          { kind: "push", idempotencyKey: "k1" },
          { kind: "pr-comment", idempotencyKey: "k2" },
        ],
      }),
    Error,
    "simulated crash mid-append",
  );
  const cps = Number((db.prepare("SELECT COUNT(*) AS c FROM world_checkpoints").get() as { c: number }).c);
  const effs = Number((db.prepare("SELECT COUNT(*) AS c FROM world_effects").get() as { c: number }).c);
  assertEquals(cps, 0, "the checkpoint row was rolled back — no half-written checkpoint");
  assertEquals(effs, 0, "the first effect row was rolled back too — the whole write is atomic");
});
