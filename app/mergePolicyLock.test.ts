import assert from "node:assert/strict";
import { test } from "node:test";
import { withMergePolicyLock } from "./mergePolicyLock.ts";

// PR #950 review: gated adoption (engine humanApproval=true, stamp 1) and merge approval (engine
// complete, stamp 0) must never interleave on one loop, or the projection ends at a stale 1.
test("engine-write/projection-stamp pairs on the same loop never interleave", async () => {
  const log: string[] = [];
  let projection: number | null = null;
  let releaseAdopt!: () => void;
  const adoptEngineWritten = new Promise<void>((r) => {
    releaseAdopt = r;
  });
  const adopt = withMergePolicyLock("loop-1", async () => {
    log.push("adopt:engine");
    await adoptEngineWritten; // the approval tries to run while adoption is mid-pair
    projection = 1;
    log.push("adopt:stamp");
  });
  const approve = withMergePolicyLock("loop-1", async () => {
    log.push("approve:engine");
    projection = 0;
    log.push("approve:stamp");
  });
  await Promise.resolve();
  releaseAdopt();
  await Promise.all([adopt, approve]);
  assert.deepEqual(log, ["adopt:engine", "adopt:stamp", "approve:engine", "approve:stamp"]);
  assert.equal(projection, 0);
});

test("a failing holder releases the lock; other keys run independently", async () => {
  await assert.rejects(
    withMergePolicyLock("loop-2", async () => {
      throw new Error("boom");
    }),
  );
  assert.equal(await withMergePolicyLock("loop-2", async () => "next"), "next");
  let release!: () => void;
  const held = withMergePolicyLock("loop-3", () => new Promise<void>((r) => (release = r)));
  assert.equal(await withMergePolicyLock("loop-4", async () => "free"), "free");
  release();
  await held;
});
