// Unit tests for the SUPPLY cockpit view-model projection (H5 / #148).
import assert from "node:assert/strict";
import { test } from "node:test";

import { type SupplyReport, supplyView } from "./supply-view.ts";

function report(over: Partial<SupplyReport> = {}): SupplyReport {
  const workers = over.workers ?? [];
  return {
    workers,
    leaves: over.leaves ?? [],
    count: over.count ?? workers.length,
    generatedAt: over.generatedAt,
  };
}

test("grades liveness: down when disconnected, stale past the threshold, else live", () => {
  const view = supplyView(
    report({
      workers: [
        { instance: "a", identity: "t", stream: "a", jobKeys: [], live: false, staleMs: 0 },
        { instance: "b", identity: "t", stream: "b", jobKeys: [], live: true, staleMs: 20_000 },
        { instance: "c", identity: "t", stream: "c", jobKeys: [], live: true, staleMs: 100 },
      ],
    }),
    { staleAfterMs: 15_000 },
  );
  assert.equal(view.workers.find((w) => w.instance === "a")?.liveness, "down");
  assert.equal(view.workers.find((w) => w.instance === "b")?.liveness, "stale");
  assert.equal(view.workers.find((w) => w.instance === "c")?.liveness, "live");
  assert.equal(view.count, 3);
  assert.equal(view.live, 1);
});

test("defaults absent family/host to a stable dash and counts + sorts jobKeys", () => {
  const view = supplyView(
    report({
      workers: [{ instance: "a", identity: "t", stream: "a", jobKeys: ["z", "a"], live: true, staleMs: 0 }],
    }),
  );
  const w = view.workers[0];
  assert.equal(w?.family, "—");
  assert.equal(w?.host, "—");
  assert.deepEqual(w?.jobKeys, ["a", "z"]);
  assert.equal(w?.jobs, 2);
});

test("sorts leaves by token and workers by instance, with per-leaf live counts", () => {
  const view = supplyView(
    report({
      leaves: [
        {
          token: "leaf-b",
          workers: [
            { instance: "b2", identity: "leaf-b", stream: "b2", jobKeys: [], live: true, staleMs: 0 },
            { instance: "b1", identity: "leaf-b", stream: "b1", jobKeys: [], live: false, staleMs: 0 },
          ],
        },
        {
          token: "leaf-a",
          workers: [{ instance: "a1", identity: "leaf-a", stream: "a1", jobKeys: [], live: true, staleMs: 0 }],
        },
      ],
    }),
  );
  assert.deepEqual(
    view.leaves.map((l) => l.token),
    ["leaf-a", "leaf-b"],
  );
  assert.deepEqual(
    view.leaves[1]?.workers.map((w) => w.instance),
    ["b1", "b2"],
  );
  assert.equal(view.leaves[1]?.liveCount, 1);
  assert.equal(view.leaves[1]?.total, 2);
});
