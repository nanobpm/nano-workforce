// Tests for the durable world store (issue #324, ADR 0062 Slice 4/5) against a REAL in-memory SQLite
// engine with migration 049 applied — so the monotonic checkpoint offset, the effect-tail ordering,
// and the durable fence (`UNIQUE(pr_key, idempotency_key)` → `isApplied`/`markApplied`) are proven,
// not mocked.
import { test } from "node:test";
import { assert, assertEquals, assertRejects, assertThrows } from "#test-assert";
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

test("the schema enforces one checkpoint row per (pr, commit SHA) — a raw duplicate insert is rejected", async () => {
  const { data, db } = memWorldData();
  const store = new WorldStore(data);
  // The application path is idempotent (reuses the offset), so exercise the DURABLE guard directly:
  // a second raw row for the same {pr_key, commit_sha} — as a racing/duplicate writer or legacy data
  // could produce — must be rejected by `UNIQUE(pr_key, commit_sha)`, not silently accepted (which
  // would let `findOne` pick an arbitrary offset and shadow the real effect tail).
  await store.recordCheckpoint({ prKey: PR, roundNo: 1, commitSha: "sha-a" });
  assertThrows(
    () =>
      db
        .prepare("INSERT INTO world_checkpoints (pr_key, round_no, checkpoint_offset, commit_sha, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(PR, 2, 1, "sha-a", new Date().toISOString()),
    Error,
    "UNIQUE",
  );
  const cps = await data.table("world_checkpoints", "id").find({ pr_key: PR, commit_sha: "sha-a" });
  assertEquals(cps.length, 1, "still exactly one checkpoint row for the SHA");
});

test("fenceFor.markApplied appends new effects at the next seq — no seq collision at a shared offset", async () => {
  const { data, db } = memWorldData();
  const store = new WorldStore(data);
  // recordCheckpoint seeds offset 0 with the default push effect at seq 0.
  await store.recordCheckpoint({ prKey: PR, roundNo: 1, commitSha: "sha-a" });
  const fence = store.fenceFor(PR, 0);
  // Two brand-new applied effects at the SAME offset must NOT both land at seq 0 (which would make
  // effectTail's `a.seq - b.seq` tie-sort non-deterministic) — each takes the next available seq.
  await fence.markApplied({ kind: "pr-comment", idempotencyKey: "c-1" });
  await fence.markApplied({ kind: "merge", idempotencyKey: "m-1" });
  const seqs = (
    db.prepare("SELECT seq FROM world_effects WHERE pr_key = ? AND checkpoint_offset = 0 ORDER BY seq").all(PR) as {
      seq: number;
    }[]
  ).map((r) => r.seq);
  assertEquals(seqs, [0, 1, 2], "each new effect appends at a distinct, monotonically increasing seq");
  const tail = await store.effectTail(PR, 0);
  assertEquals(
    tail.map((e) => e.idempotencyKey),
    ["sha-a", "c-1", "m-1"],
    "effectTail is deterministically ordered — insertion order, no ties",
  );
});

test("recordCheckpoint tolerates a concurrent duplicate checkpoint insert — reuses the raced offset, no spurious failure", async () => {
  const { data, db } = memWorldData();
  // The check-then-insert race the `UNIQUE(pr_key, commit_sha)` fence guards: a concurrent/duplicate
  // persist-round lands the checkpoint row for the SAME {pr, commit SHA} AFTER our `findOne` missed but
  // BEFORE our `insert`. Decorate the transaction-scoped checkpoints table so the first insert first
  // writes a concurrent row for the SHA, then delegates — the real insert now hits the fence.
  const realOpen = (data as unknown as { open: () => Record<string, unknown> }).open.bind(data);
  (data as unknown as { open: () => Record<string, unknown> }).open = () => {
    const ds = realOpen();
    const realTable = (ds.table as (name: string, pk?: string) => Record<string, unknown>).bind(ds);
    let injected = false;
    ds.table = (name: string, pk?: string) => {
      const t = realTable(name, pk);
      if (name === "world_checkpoints") {
        const realInsert = (t.insert as (row: unknown) => Promise<number>).bind(t);
        t.insert = async (row: unknown) => {
          if (!injected) {
            injected = true;
            db.prepare(
              "INSERT INTO world_checkpoints (pr_key, round_no, checkpoint_offset, commit_sha, created_at) VALUES (?, ?, ?, ?, ?)",
            ).run(PR, 9, 0, "sha-a", new Date().toISOString());
          }
          return realInsert(row);
        };
      }
      return t;
    };
    return ds;
  };
  const store = new WorldStore(data);
  const offset = await store.recordCheckpoint({ prKey: PR, roundNo: 1, commitSha: "sha-a" });
  assertEquals(offset, 0, "the race is reconciled to the winner's offset, not surfaced as a spurious error");
  const cps = await data.table("world_checkpoints", "id").find({ pr_key: PR, commit_sha: "sha-a" });
  assertEquals(cps.length, 1, "exactly one checkpoint row for the SHA — the fence held");
  assertEquals(
    (await store.effectTail(PR, offset)).map((e) => e.idempotencyKey),
    ["sha-a"],
    "the push effect still lands at the reused offset",
  );
});

test("recordCheckpoint tolerates a concurrent duplicate effect insert — the fence collapses it, no spurious failure", async () => {
  const { data, db } = memWorldData();
  // The effect ledger's `UNIQUE(pr_key, idempotency_key)` fence, raced: a concurrent writer records the
  // SAME idempotency key between our `findOne` miss and our `insert`. Decorate so the FIRST effect insert
  // first writes a concurrent row for that key, then delegates — the real insert hits the fence.
  const realOpen = (data as unknown as { open: () => Record<string, unknown> }).open.bind(data);
  (data as unknown as { open: () => Record<string, unknown> }).open = () => {
    const ds = realOpen();
    const realTable = (ds.table as (name: string, pk?: string) => Record<string, unknown>).bind(ds);
    let injected = false;
    ds.table = (name: string, pk?: string) => {
      const t = realTable(name, pk);
      if (name === "world_effects") {
        const realInsert = (t.insert as (row: unknown) => Promise<number>).bind(t);
        t.insert = async (row: unknown) => {
          if (!injected) {
            injected = true;
            db.prepare(
              "INSERT INTO world_effects (pr_key, checkpoint_offset, seq, kind, idempotency_key, description, applied, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ).run(PR, 0, 0, "push", "sha-a", null, 1, new Date().toISOString());
          }
          return realInsert(row);
        };
      }
      return t;
    };
    return ds;
  };
  const store = new WorldStore(data);
  const offset = await store.recordCheckpoint({
    prKey: PR,
    roundNo: 1,
    commitSha: "sha-a",
    effects: [push("sha-a"), { kind: "pr-comment", idempotencyKey: "c-1" }],
  });
  const dup = await data.table("world_effects", "id").find({ pr_key: PR, idempotency_key: "sha-a" });
  assertEquals(dup.length, 1, "the raced idempotency key yields exactly one row — the fence collapsed the duplicate");
  assertEquals(
    (await store.effectTail(PR, offset)).map((e) => e.idempotencyKey),
    ["sha-a", "c-1"],
    "the remaining effect still records after the collapsed duplicate — no spurious failure",
  );
});

test("fenceFor.markApplied tolerates a concurrent effect insert — reconciles the raced row to applied, no spurious failure", async () => {
  const { data, db } = memWorldData();
  const store = new WorldStore(data);
  await store.recordCheckpoint({ prKey: PR, roundNo: 1, commitSha: "sha-a" });
  // Race markApplied's check-then-insert: a concurrent restore records the SAME key (as a PENDING tail
  // entry) between our `findOne` miss and our `insert`. Decorate `table` so the effect insert first
  // writes that concurrent pending row, then delegates — the real insert hits the fence.
  const realTable = (data as unknown as { table: (name: string, pk?: string) => Record<string, unknown> }).table.bind(data);
  let injected = false;
  (data as unknown as { table: (name: string, pk?: string) => Record<string, unknown> }).table = (name: string, pk?: string) => {
    const t = realTable(name, pk);
    if (name === "world_effects") {
      const realInsert = (t.insert as (row: unknown) => Promise<number>).bind(t);
      t.insert = async (row: unknown) => {
        if (!injected) {
          injected = true;
          db.prepare(
            "INSERT INTO world_effects (pr_key, checkpoint_offset, seq, kind, idempotency_key, description, applied, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          ).run(PR, 0, 5, "merge", "m-1", null, 0, new Date().toISOString());
        }
        return realInsert(row);
      };
    }
    return t;
  };
  const fence = store.fenceFor(PR, 0);
  await fence.markApplied({ kind: "merge", idempotencyKey: "m-1" });
  assert(await fence.isApplied("m-1"), "the raced pending row is reconciled to applied, not left pending or surfaced as an error");
  const rows = await data.table("world_effects", "id").find({ pr_key: PR, idempotency_key: "m-1" });
  assertEquals(rows.length, 1, "exactly one row for the key — the fence collapsed the duplicate");
});

test("recordCheckpoint re-recording a pending effect as applied reconciles the fence — no re-apply on restore", async () => {
  const { data } = memWorldData();
  const store = new WorldStore(data);
  // Round records a tail effect PENDING (applied=false) — recorded before it is performed.
  await store.recordCheckpoint({
    prKey: PR,
    roundNo: 1,
    commitSha: "sha-a",
    effects: [{ kind: "pr-comment", idempotencyKey: "c-1" }],
    applied: false,
  });
  const fence = store.fenceFor(PR, 0);
  assertEquals(await fence.isApplied("c-1"), false, "pending before it lands");
  // The effect lands; a later record of the SAME key now knows it is applied. The duplicate-key
  // short-circuit must NOT drop that knowledge — it must reconcile the surviving row to applied, or a
  // later restore re-applies an already-executed side effect.
  await store.recordCheckpoint({
    prKey: PR,
    roundNo: 2,
    commitSha: "sha-a",
    effects: [{ kind: "pr-comment", idempotencyKey: "c-1" }],
    applied: true,
  });
  assertEquals(
    await fence.isApplied("c-1"),
    true,
    "a re-record that knows the effect landed flips the pending row to applied (fence reconciled)",
  );
  const rows = await data.table("world_effects", "id").find({ pr_key: PR, idempotency_key: "c-1" });
  assertEquals(rows.length, 1, "still exactly one row — the fence collapsed the re-record, it did not duplicate");
});

test("recordCheckpoint re-recording an applied effect as pending never un-applies it (monotone fence)", async () => {
  const { data } = memWorldData();
  const store = new WorldStore(data);
  await store.recordCheckpoint({
    prKey: PR,
    roundNo: 1,
    commitSha: "sha-a",
    effects: [{ kind: "pr-comment", idempotencyKey: "c-1" }],
    applied: true,
  });
  const fence = store.fenceFor(PR, 0);
  assertEquals(await fence.isApplied("c-1"), true, "applied after it lands");
  // A stray re-record carrying applied=false must NOT retreat the fence — an already-executed effect
  // cannot become pending again, or a restore would re-apply it.
  await store.recordCheckpoint({
    prKey: PR,
    roundNo: 2,
    commitSha: "sha-a",
    effects: [{ kind: "pr-comment", idempotencyKey: "c-1" }],
    applied: false,
  });
  assertEquals(await fence.isApplied("c-1"), true, "a later pending re-record never un-applies (fence is monotone)");
});
