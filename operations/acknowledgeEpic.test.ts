// Tests for the POST /app/api/actions/acknowledge-epic operation `acknowledgeEpic` (issue #298).
// The nwf UI's "Dismiss" affordance for a fully-LANDED epic: it stamps `acknowledged_at` via the
// plans gateway, which recomputes `list_bucket` to 'history' (and `ack_open` to 0), dropping the
// landed epic from Active into History. Unlike acknowledge-blocked it completes NO user task (a
// landed epic is not parked). The epic twin of acknowledge-done.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { plans } from "../app/plan.ts";
import { noopLog } from "../test/log.ts";
import handler from "./acknowledgeEpic.ts";

// An in-memory data layer wired through the REAL plans gateway proxy, so the test exercises the
// gateway's list_bucket/ack_open projection exactly as production does.
function memApp(seed: any[]): { app: AppApi; rows: any[] } {
  const stores: Record<string, any[]> = { plans: seed };
  function tbl(name: string, pk = "id") {
    const rows = (stores[name] ??= [] as any[]);
    const match = (r: any, where: any) => Object.entries(where).every(([k, v]) => r[k] === v);
    return {
      async all() {
        return rows.slice();
      },
      async get(id: any) {
        return rows.find((r) => r[pk] === id);
      },
      async find(where: any = {}) {
        return rows.filter((r) => match(r, where));
      },
      async insert(row: any) {
        rows.push({ ...row });
        return row[pk];
      },
      async update(id: any, patch: any) {
        const r = rows.find((row) => row[pk] === id);
        if (r) Object.assign(r, patch);
        return r ? 1 : 0;
      },
    };
  }
  const app = {
    data: { table: (n: string, pk?: string) => tbl(n, pk) },
    log: noopLog(),
  } as any as AppApi;
  return { app, rows: stores.plans };
}

async function call(app: AppApi, body: unknown) {
  return (await handler({ req: {} as any, params: {}, query: {}, body } as any, app)) as any;
}

test("acknowledge-epic: stamps acknowledged_at and flips list_bucket to 'history' on a landed epic", async () => {
  const { app, rows } = memApp([{ plan_key: "o/r#1", status: "done", delivery: "landed", acknowledged_at: null }]);
  // Seed the projection as the gateway would have on the last write (landed, unacknowledged → active).
  await plans(app.data).update("o/r#1", { delivery: "landed" });
  assertEquals(rows[0].list_bucket, "active");
  assertEquals(rows[0].ack_open, 1);

  const res = await call(app, { plan_key: "o/r#1" });

  assertEquals(res.status, 200);
  assertEquals(res.body.ok, true);
  assertEquals(typeof rows[0].acknowledged_at, "string");
  assertEquals(rows[0].list_bucket, "history");
  assertEquals(rows[0].ack_open, 0);
});

test("acknowledge-epic: a still-converging epic is rejected (409) and stays Active", async () => {
  const { app, rows } = memApp([{ plan_key: "o/r#2", status: "done", delivery: "converging", acknowledged_at: null }]);
  await plans(app.data).update("o/r#2", { delivery: "converging" });

  const res = await call(app, { plan_key: "o/r#2" });

  assertEquals(res.status, 409);
  assertEquals(res.body.ok, false);
  // Untouched: no premature acknowledged_at, still Active.
  assertEquals(rows[0].acknowledged_at, null);
  assertEquals(rows[0].list_bucket, "active");
});

test("acknowledge-epic: a resolved-not-landed epic (delivery=null) is accepted (200) and flips to History", async () => {
  const { app, rows } = memApp([{ plan_key: "o/r#2b", status: "done", delivery: null, acknowledged_at: null }]);
  // Seed the projection as the gateway would have on the last write (resolved-not-landed, unacknowledged → active).
  await plans(app.data).update("o/r#2b", { delivery: null });
  assertEquals(rows[0].list_bucket, "active");
  assertEquals(rows[0].ack_open, 1);

  const res = await call(app, { plan_key: "o/r#2b" });

  assertEquals(res.status, 200);
  assertEquals(res.body.ok, true);
  assertEquals(typeof rows[0].acknowledged_at, "string");
  assertEquals(rows[0].list_bucket, "history");
  assertEquals(rows[0].ack_open, 0);
});

test("acknowledge-epic: a live (dispatched) epic is rejected (409)", async () => {
  const { app } = memApp([{ plan_key: "o/r#3", status: "dispatched", delivery: null, acknowledged_at: null }]);
  const res = await call(app, { plan_key: "o/r#3" });
  assertEquals(res.status, 409);
});

test("acknowledge-epic: a missing plan_key → 400", async () => {
  const { app } = memApp([]);
  const res = await call(app, {});
  assertEquals(res.status, 400);
});

test("acknowledge-epic: no matching epic → 404", async () => {
  const { app } = memApp([]);
  const res = await call(app, { plan_key: "o/r#404" });
  assertEquals(res.status, 404);
});

test("acknowledge-epic: idempotent — re-acknowledging a landed epic keeps it in History", async () => {
  const { app, rows } = memApp([{ plan_key: "o/r#5", status: "done", delivery: "landed", acknowledged_at: null }]);
  await plans(app.data).update("o/r#5", { delivery: "landed" });

  assertEquals((await call(app, { plan_key: "o/r#5" })).status, 200);
  const firstStamp = rows[0].acknowledged_at;
  assertEquals(rows[0].list_bucket, "history");

  const res2 = await call(app, { plan_key: "o/r#5" });
  assertEquals(res2.status, 200);
  assertEquals(rows[0].list_bucket, "history");
  // Re-stamped (a fresh timestamp) but still resolved.
  assertEquals(typeof rows[0].acknowledged_at, "string");
  void firstStamp;
});
