// Issue #1023: the convergence loop must not dispatch an agent job for a PR that is already merged or
// closed. `pr.liveness-check` runs before every agent dispatch and publishes `prGone`.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrState } from "../../app/github.ts";
import { makeHandler } from "./worker.ts";

function fakeApp(rows: Record<string, unknown>[]) {
  const updates: Array<[unknown, Record<string, unknown>]> = [];
  const table = (_name: string, key: string) => ({
    get: async (k: unknown) => rows.find((r) => r[key] === k),
    findOne: async () => null,
    find: async () => [],
    insert: async () => 1,
    update: async (k: unknown, patch: Record<string, unknown>) => {
      updates.push([k, patch]);
      const row = rows.find((r) => r[key] === k);
      if (row) Object.assign(row, patch);
    },
  });
  const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  // biome-ignore lint/plugin: minimal in-memory AppApi test double
  return { app: { data: { table }, log } as never, updates };
}

// biome-ignore lint/plugin: bare stub job — the worker reads only variables + processInstanceKey
const job = (variables: Record<string, unknown>, processInstanceKey = "PI-1") => ({ variables, processInstanceKey }) as never;
// biome-ignore lint/plugin: partial PrState — classifyPrLiveness reads only merged/state
const st = (s: Partial<PrState>) => s as PrState;

test("liveness-check: a MERGED PR publishes prGone=merged and marks the row merged", async () => {
  const rows = [{ pr_key: "o/r#1", process_key: "PI-1", status: "converging" }];
  const { app, updates } = fakeApp(rows);
  const handler = makeHandler({ readPrState: async () => st({ merged: true, state: "closed" }) });
  assert.deepEqual(await handler(job({ prKey: "o/r#1", repo: "o/r", prNumber: 1 }), app), { prGone: "merged" });
  assert.equal(rows[0].status, "merged");
  assert.equal(updates.length, 1);
});

test("liveness-check: a CLOSED (unmerged) PR publishes prGone=closed", async () => {
  const { app } = fakeApp([{ pr_key: "o/r#1", process_key: "PI-1", status: "converging" }]);
  const handler = makeHandler({ readPrState: async () => st({ merged: false, state: "closed" }) });
  assert.deepEqual(await handler(job({ prKey: "o/r#1", repo: "o/r", prNumber: 1 }), app), { prGone: "closed" });
});

test("liveness-check: an OPEN PR publishes an empty prGone (dispatch proceeds)", async () => {
  const { app, updates } = fakeApp([]);
  const handler = makeHandler({ readPrState: async () => st({ merged: false, state: "open" }) });
  assert.deepEqual(await handler(job({ prKey: "o/r#1" }), app), { prGone: "" });
  assert.equal(updates.length, 0);
});

test("liveness-check: an unreadable/throwing state fails OPEN (never ends a live loop)", async () => {
  const { app } = fakeApp([]);
  assert.deepEqual(await makeHandler({ readPrState: async () => null })(job({ prKey: "o/r#1" }), app), { prGone: "" });
  const throwing = makeHandler({
    readPrState: async () => {
      throw new Error("down");
    },
  });
  assert.deepEqual(await throwing(job({ prKey: "o/r#1" }), app), { prGone: "" });
});

test("liveness-check: a superseded run still ends its own loop but never writes the new run's row", async () => {
  const rows = [{ pr_key: "o/r#1", process_key: "PI-NEW", status: "converging" }];
  const { app, updates } = fakeApp(rows);
  const handler = makeHandler({ readPrState: async () => st({ merged: true, state: "closed" }) });
  assert.deepEqual(await handler(job({ prKey: "o/r#1" }, "PI-OLD"), app), { prGone: "merged" });
  assert.equal(updates.length, 0);
});
