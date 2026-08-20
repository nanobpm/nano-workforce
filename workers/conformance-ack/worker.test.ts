// Unit coverage for pr.conformance-ack — the operator acknowledged a conformance-review escalation
// (issue #216). It must settle the parked `plan_conformance` row at `review_status = 'reviewed'` so
// the inbox scan drops it (the retro instance COMPLETES normally, so `instanceTracking.onTerminated`
// never fires) and fold the operator's disposition note into the audit `summary`.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { noopLog } from "../../test/log.ts";
import handler from "./worker.ts";

function fakeApp(rows: Record<string, unknown>[]) {
  const stores: Record<string, Record<string, unknown>[]> = { plan_conformance: rows };
  return {
    data: {
      table(name: string, key: string) {
        const store = (stores[name] ??= []);
        return {
          get: (k: any) => Promise.resolve(store.find((r) => r[key] === k)),
          find: (q: any) => Promise.resolve(store.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
          insert: (row: any) => {
            store.push(row);
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
    log: noopLog(),
  } as any;
}

test("conformance-ack: settles the review at reviewed and appends the operator note to the summary", async () => {
  const rows = [{ plan_key: "owner/repo#7", review_status: "reviewing", summary: "slice 2 reduced" }];
  const app = fakeApp(rows);
  const out = await handler({ variables: { planKey: "owner/repo#7", note: "filed follow-up #9" } } as any, app);
  assertEquals(out, {});
  assertEquals(rows[0].review_status, "reviewed");
  assertEquals(rows[0].summary, "slice 2 reduced\n\nOperator ack: filed follow-up #9");
});

test("conformance-ack: a blank note settles the review without touching the summary", async () => {
  const rows = [{ plan_key: "owner/repo#8", review_status: "reviewing", summary: "auth cache unverified" }];
  const app = fakeApp(rows);
  await handler({ variables: { planKey: "owner/repo#8", note: "   " } } as any, app);
  assertEquals(rows[0].review_status, "reviewed");
  assertEquals(rows[0].summary, "auth cache unverified");
});
