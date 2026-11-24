// Issue #1047: the merges audit writers stay bounded across a spinning merge loop.
import test from "node:test";
import type { DataLayer } from "@nanobpm/urban";
import { assertEquals } from "#test-assert";
import { recordMergedOnce, recordUnlessRepeat } from "./mergeAudit.ts";
import { reviewWaitReason } from "./reviewWait.ts";

type Row = Record<string, unknown>;

/** In-memory `merges` table with the migration-147 `ux_merges_merged_pr` fence. */
function fakeData(rows: Row[] = []): { data: DataLayer; rows: Row[] } {
  let next = 1;
  const match = (r: Row, q: Row) => Object.entries(q).every(([k, v]) => r[k] === v);
  const table = {
    find: async (q: Row) => rows.filter((r) => match(r, q)),
    findOne: async (q: Row) => rows.find((r) => match(r, q)) ?? null,
    insert: async (r: Row) => {
      if (r.outcome === "merged" && rows.some((x) => x.outcome === "merged" && x.pr_key === r.pr_key)) {
        throw new Error("UNIQUE constraint failed: merges.pr_key");
      }
      rows.push({ ...r, id: next++ });
      return next - 1;
    },
    delete: async (id: unknown) => {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
      return i >= 0 ? 1 : 0;
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: minimal DataLayer test double
  const data: any = { table: () => table };
  return { data, rows };
}

const PR = "o/r#1";
const HEAD = "a".repeat(40);
const pending = { pr_key: PR, outcome: "review-pending", method: "review-backstop", detail: `no review [head ${HEAD}]`, at: "t" };

test("recordMergedOnce: replays write exactly one merged row", async () => {
  const { data, rows } = fakeData();
  assertEquals(await recordMergedOnce(data, { pr_key: PR, method: "already-merged", detail: "d", at: "t" }), true);
  assertEquals(await recordMergedOnce(data, { pr_key: PR, method: "already-merged", detail: "d", at: "t" }), false);
  assertEquals(rows.filter((r) => r.outcome === "merged").length, 1);
});

test("recordUnlessRepeat: the full request → re-arm → repeat cycle stays bounded per PR/head", async () => {
  const { data, rows } = fakeData();
  for (let lap = 0; lap < 5; lap++) {
    await recordUnlessRepeat(data, pending);
    // pr.request-review, then the poller's head-marked ask, then pr.arm-merge closing the wait.
    await data.table("merges", "id").insert({ pr_key: PR, outcome: "review-requested", method: "review-request", detail: `request #${lap + 1}: requested`, at: "t" });
    if (lap === 0) {
      await data.table("merges", "id").insert({ pr_key: PR, outcome: "review-requested", method: "review-request", detail: `poller requested [head ${HEAD}]`, at: "t" });
    }
    await data.table("merges", "id").insert({ pr_key: PR, outcome: "review-wait-ended", method: "arm-merge", detail: "ended", at: "t" });
  }
  await recordUnlessRepeat(data, pending);
  assertEquals(rows.filter((r) => r.outcome === "review-pending").length, 1);
  assertEquals(rows.filter((r) => r.outcome === "review-wait-ended").length, 0);
  // The poller's per-head ask budget row survives; the worker asks of earlier laps are collapsed.
  assertEquals(rows.filter((r) => String(r.detail).includes("poller")).length, 1);
  assertEquals(rows.length, 2);
  // /status still reports the live wait for the head.
  // biome-ignore lint/suspicious/noExplicitAny: test projection
  assertEquals(reviewWaitReason(rows as any), `waiting_review(${HEAD.slice(0, 7)})`);
});

test("recordUnlessRepeat: an identical newest row is not re-appended; a different head is", async () => {
  const { data, rows } = fakeData();
  await recordUnlessRepeat(data, pending);
  assertEquals(await recordUnlessRepeat(data, pending), false);
  const other = { ...pending, detail: `no review [head ${"b".repeat(40)}]` };
  assertEquals(await recordUnlessRepeat(data, other), true);
  assertEquals(rows.length, 2);
});

test("recordUnlessRepeat: a non-wait row breaks the cycle — history before it is kept", async () => {
  const { data, rows } = fakeData();
  await recordUnlessRepeat(data, pending);
  await data.table("merges", "id").insert({ pr_key: PR, outcome: "blocked", method: "m", detail: "ci red", at: "t" });
  await recordUnlessRepeat(data, pending);
  assertEquals(rows.length, 3);
});
