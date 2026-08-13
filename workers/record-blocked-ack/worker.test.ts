// Unit coverage for pr.record-blocked-ack — the operator acknowledged a blocked feature run.
// It must settle the parked (non-terminal `awaiting_operator`) row at terminal `blocked` and record
// the operator's disposition note into `delivery_label` so the same issue can be re-dispatched.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { noopLog } from "../../test/log.ts";
import handler from "./worker.ts";

function fakeApp(rows: Record<string, unknown>[]) {
  const stores: Record<string, Record<string, unknown>[]> = { feature_runs: rows };
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

test("record-blocked-ack: settles the parked run at terminal blocked and records the operator note", async () => {
  const rows = [{ feature_key: "owner/repo#7", status: "awaiting_operator", delivery_label: null }];
  const app = fakeApp(rows);
  const out = await handler({ variables: { featureKey: "owner/repo#7", note: "reassigned to a human" } } as any, app);
  assertEquals(out, {});
  assertEquals(rows[0].status, "blocked");
  assertEquals(rows[0].delivery_label, "operator: reassigned to a human");
});

test("record-blocked-ack: a blank note falls back to an 'acknowledged' label", async () => {
  const rows = [{ feature_key: "owner/repo#8", status: "awaiting_operator", delivery_label: null }];
  const app = fakeApp(rows);
  await handler({ variables: { featureKey: "owner/repo#8", note: "   " } } as any, app);
  assertEquals(rows[0].status, "blocked");
  assertEquals(rows[0].delivery_label, "acknowledged");
});
