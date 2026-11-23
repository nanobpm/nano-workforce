// Issue #1034: re-arming the merge poller ends any open review wait, so /status stops deriving
// `waiting_review(<sha7>)` once a clean review lands even if CI stays pending (no new merge row).
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { reviewWaitReason } from "../../app/reviewWait.ts";
import handler from "./worker.ts";

function fakeApp(merges: Record<string, unknown>[]) {
  const stores: Record<string, Record<string, unknown>[]> = {
    pull_requests: [{ pr_key: "o/r#1", status: "merging" }],
    merges,
  };
  const app = {
    data: {
      table(name: string, key: string) {
        const store = (stores[name] ??= []);
        return {
          find: (q: any) =>
            Promise.resolve(store.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
          insert: (row: any) => {
            store.push({ id: store.length + 1, ...row });
            return Promise.resolve(store.length);
          },
          update: (k: any, patch: any) => {
            const row = store.find((r) => r[key] === k);
            if (row) Object.assign(row, patch);
            return Promise.resolve(row);
          },
        };
      },
    },
  } as any;
  return { app, stores };
}

const rowsOf = (s: Record<string, unknown>[]) =>
  s.map((r) => ({ id: Number(r.id), outcome: String(r.outcome), detail: (r.detail as string) ?? null }));

test("arm-merge closes an open review wait so the derived waitReason clears", async () => {
  const { app, stores } = fakeApp([
    { id: 1, pr_key: "o/r#1", outcome: "review-pending", detail: "x [head 51c424c0000000]" },
    { id: 2, pr_key: "o/r#1", outcome: "review-requested", detail: "requested" },
  ]);
  assertEquals(reviewWaitReason(rowsOf(stores.merges)), "waiting_review(51c424c)");
  await handler({ variables: { prKey: "o/r#1" } } as any, app);
  assertEquals(stores.pull_requests[0].status, "waiting_merge");
  assertEquals(stores.merges.length, 3);
  assertEquals(stores.merges[2].outcome, "review-wait-ended");
  assertEquals(reviewWaitReason(rowsOf(stores.merges)), null);
});

test("arm-merge writes no audit row when no review wait is open", async () => {
  const { app, stores } = fakeApp([{ id: 1, pr_key: "o/r#1", outcome: "blocked", detail: "" }]);
  await handler({ variables: { prKey: "o/r#1" } } as any, app);
  assertEquals(stores.merges.length, 1);
  const empty = fakeApp([]);
  await handler({ variables: { prKey: "o/r#1" } } as any, empty.app);
  assertEquals(empty.stores.merges.length, 0);
});
