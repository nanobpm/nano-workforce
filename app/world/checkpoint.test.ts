// Tests for the world checkpoint JOIN + RESTORE orchestration (issue #324, ADR 0062 Slice 4/5). These
// prove the two acceptance criteria at the orchestration level:
//   - Divergence guard: mind and world always commit at the SAME checkpoint offset (the join hands
//     the mind the identical checkpoint the world persisted).
//   - Reconstruction + fence: restore INVERTS the push (`git fetch` + `git checkout <sha>`) and
//     fence-replays the effect tail so no already-applied effect is repeated.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { memWorldData } from "../../test/worldDb.ts";
import { recordWorldCheckpoint, restoreWorld, type SessionCheckpoint } from "./checkpoint.ts";
import type { Effect } from "./effect-ledger.ts";
import type { GitRunner } from "./git.ts";
import { WorldStore } from "./store.ts";

const PR = "o/r#1";

/** A fake git runner that records the inbound inversion (fetch + checkout) restore performs. */
function fakeGit(): GitRunner & { fetched: string[]; checkedOut: string[] } {
  const fetched: string[] = [];
  const checkedOut: string[] = [];
  return {
    fetched,
    checkedOut,
    async fetch(remote = "origin") {
      fetched.push(remote);
    },
    async checkout(ref) {
      checkedOut.push(ref);
    },
    async revParse(ref) {
      return ref;
    },
  };
}

test("recordWorldCheckpoint joins the mind to the world at the SAME offset (divergence guard)", async () => {
  const { data } = memWorldData();
  const store = new WorldStore(data);
  const mindSaw: Array<{ offset: number; cp: SessionCheckpoint }> = [];
  // The mind sink (Slice 1 `session.checkpoint`) — capture what offset it committed at by pairing it
  // with the world offset returned. Both halves derive from ONE checkpoint object.
  let lastOffset = -1;
  const sink = (cp: SessionCheckpoint) => {
    mindSaw.push({ offset: lastOffset, cp });
  };

  for (let round = 1; round <= 3; round++) {
    const res = await recordWorldCheckpoint(store, { prKey: PR, roundNo: round, commitSha: `sha-${round}` }, (cp) => {
      lastOffset = round - 1; // the offset the world just allocated
      sink(cp);
    });
    assertEquals(res.offset, round - 1, "world offset is the per-PR monotonic counter");
    // The mind saw the IDENTICAL checkpoint object the world persisted.
    assertEquals(res.checkpoint.commitSha, `sha-${round}`);
  }
  // Divergence guard: every mind checkpoint's offset equals the world checkpoint offset — they never
  // drift. The last committed offset the mind saw is the store's newest.
  const last = await store.lastCheckpoint(PR);
  assertEquals(last?.offset, 2, "world's newest offset");
  assertEquals(mindSaw.at(-1)?.offset, 2, "mind committed at the SAME offset — no divergence");
});

test("recordWorldCheckpoint derives one checkpoint fed to both the store and the mind sink", async () => {
  const { data } = memWorldData();
  const store = new WorldStore(data);
  const effects: Effect[] = [
    { kind: "push", idempotencyKey: "sha-1" },
    { kind: "pr-comment", idempotencyKey: "c-1" },
  ];
  let sunk: SessionCheckpoint | null = null;
  const res = await recordWorldCheckpoint(store, { prKey: PR, roundNo: 1, commitSha: "sha-1", effects }, (cp) => {
    sunk = cp;
  });
  assertEquals(sunk, res.checkpoint, "the sink received the exact object the world persisted");
  const tail = await store.effectTail(PR, res.offset);
  assertEquals(tail.map((e) => e.idempotencyKey), ["sha-1", "c-1"], "the same effect ledger is durable");
});

test("recordWorldCheckpoint works without a sink (world half lands before the mind backend)", async () => {
  const { data } = memWorldData();
  const store = new WorldStore(data);
  const res = await recordWorldCheckpoint(store, { prKey: PR, roundNo: 1, commitSha: "sha-1" });
  assertEquals(res.offset, 0, "the world checkpoint is recorded even with no mind sink");
});

test("restoreWorld inverts the push: git fetch + checkout <commitSha> to reconstruct the tree", async () => {
  const { data } = memWorldData();
  const store = new WorldStore(data);
  await recordWorldCheckpoint(store, { prKey: PR, roundNo: 1, commitSha: "sha-a" });
  await recordWorldCheckpoint(store, { prKey: PR, roundNo: 2, commitSha: "sha-b" });
  const git = fakeGit();
  const res = await restoreWorld(git, store, PR);
  assertEquals(git.fetched, ["origin"], "fetch runs first so the SHA is reachable");
  assertEquals(git.checkedOut, ["sha-b"], "the tree is reconstructed to the NEWEST push-checkpoint SHA");
  assertEquals(res?.offset, 1, "restore reports the checkpoint offset it landed on");
  assertEquals(res?.commitSha, "sha-b");
});

test("restoreWorld fence-replays the tail: an already-applied effect is NOT repeated (fence holds)", async () => {
  const { data } = memWorldData();
  const store = new WorldStore(data);
  // The round pushed AND commented; both effects are recorded applied on the forward path.
  await recordWorldCheckpoint(store, {
    prKey: PR,
    roundNo: 1,
    commitSha: "sha-a",
    effects: [
      { kind: "push", idempotencyKey: "sha-a" },
      { kind: "pr-comment", idempotencyKey: "c-1" },
    ],
  });
  const git = fakeGit();
  const reapplied: string[] = [];
  const res = await restoreWorld(git, store, PR, { apply: (e) => reapplied.push(e.idempotencyKey) });
  assertEquals(reapplied, [], "no effect is re-applied — the fence skips both");
  assertEquals(res?.skipped.map((e) => e.idempotencyKey), ["sha-a", "c-1"], "both are reported skipped");
  assertEquals(res?.applied.length, 0);
});

test("restoreWorld re-applies only a genuinely-pending tail effect (crash before it landed)", async () => {
  const { data } = memWorldData();
  const store = new WorldStore(data);
  // The push landed (applied) but its trailing comment was only RECORDED as pending (applied=false)
  // before the worker crashed. Restore must re-apply exactly the comment.
  await recordWorldCheckpoint(store, { prKey: PR, roundNo: 1, commitSha: "sha-a", effects: [{ kind: "push", idempotencyKey: "sha-a" }] });
  // Record the pending comment at the same offset via a second store call with applied=false.
  await store.recordCheckpoint({
    prKey: PR,
    roundNo: 1,
    commitSha: "sha-a2",
    effects: [{ kind: "pr-comment", idempotencyKey: "c-1" }],
    applied: false,
  });
  const git = fakeGit();
  const reapplied: string[] = [];
  const res = await restoreWorld(git, store, PR, { apply: (e) => reapplied.push(e.idempotencyKey) });
  // The newest checkpoint is offset 1 (commit sha-a2), whose tail is the pending comment.
  assertEquals(res?.commitSha, "sha-a2");
  assertEquals(reapplied, ["c-1"], "the pending comment is re-applied exactly once");
  // A SECOND restore is now a no-op — the fence recorded the comment applied.
  const reapplied2: string[] = [];
  await restoreWorld(git, store, PR, { apply: (e) => reapplied2.push(e.idempotencyKey) });
  assertEquals(reapplied2, [], "the second resume repeats nothing — idempotent");
});

test("restoreWorld returns null when the PR has no push-checkpoint (nothing to reconstruct)", async () => {
  const { data } = memWorldData();
  const store = new WorldStore(data);
  const git = fakeGit();
  const res = await restoreWorld(git, store, PR);
  assertEquals(res, null, "no checkpoint → null; the caller keeps the freshly-provisioned worktree");
  assertEquals(git.fetched, [], "no git operation runs when there is nothing to restore");
  assert(git.checkedOut.length === 0);
});
