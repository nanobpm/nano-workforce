// Tests for the POST /app/api/actions/acknowledge-done operation `acknowledgeDone` (issue #254 §5).
// The nwf UI's "tick off" affordance for a TERMINAL feature run: it stamps `acknowledged_at` via the
// feature_runs gateway, which recomputes `list_bucket` to 'history', dropping the run from Active into
// History. Unlike acknowledgeBlocked it completes NO user task (a terminal run is not parked). Mirrors
// the acknowledge-blocked twin's shape.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { featureRuns } from "../app/feature.ts";
import { noopLog } from "../test/log.ts";
import handler from "./acknowledgeDone.ts";

// An in-memory data layer wired through the REAL featureRuns gateway proxy, so the test exercises the
// gateway's list_bucket projection exactly as production does.
function memApp(seed: any[]): { app: AppApi; rows: any[] } {
  const stores: Record<string, any[]> = { feature_runs: seed };
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
  return { app, rows: stores.feature_runs };
}

async function call(app: AppApi, body: unknown) {
  return (await handler({ req: {} as any, params: {}, query: {}, body } as any, app)) as any;
}

test("acknowledge-done: stamps acknowledged_at and flips list_bucket to 'history' on a terminal row", async () => {
  const { app, rows } = memApp([{ feature_key: "o/r#1", status: "merged", converge: 1, auto_merge: 1, acknowledged_at: null }]);
  // Seed the projection as the gateway would have on the last write (terminal, unacknowledged → active).
  await featureRuns(app.data).update("o/r#1", { status: "merged" });
  assertEquals(rows[0].list_bucket, "active");

  const res = await call(app, { feature_key: "o/r#1" });

  assertEquals(res.status, 200);
  assertEquals(res.body.ok, true);
  assertEquals(typeof rows[0].acknowledged_at, "string");
  assertEquals(rows[0].list_bucket, "history");
});

test("acknowledge-done: idempotent-safe — re-acknowledging keeps the row in History", async () => {
  const { app, rows } = memApp([{ feature_key: "o/r#2", status: "failed", converge: 1, auto_merge: 1, acknowledged_at: null }]);
  const first = await call(app, { feature_key: "o/r#2" });
  assertEquals(first.status, 200);
  assertEquals(rows[0].list_bucket, "history");
  const firstStamp = rows[0].acknowledged_at;
  // Re-acknowledge — still 200, still history.
  const second = await call(app, { feature_key: "o/r#2" });
  assertEquals(second.status, 200);
  assertEquals(rows[0].list_bucket, "history");
  assertEquals(typeof firstStamp, "string");
});

test("acknowledge-done: a missing feature_key → 400", async () => {
  const { app } = memApp([]);
  const res = await call(app, {});
  assertEquals(res.status, 400);
  assertEquals(res.body.ok, false);
});

test("acknowledge-done: no such feature run → 404", async () => {
  const { app } = memApp([]);
  const res = await call(app, { feature_key: "o/r#gone" });
  assertEquals(res.status, 404);
  assertEquals(res.body.ok, false);
});

test("acknowledge-done: a non-terminal run → 409, no acknowledged_at stamped", async () => {
  const { app, rows } = memApp([{ feature_key: "o/r#live", status: "running", converge: 1, auto_merge: 1, acknowledged_at: null }]);
  await featureRuns(app.data).update("o/r#live", { status: "running" });
  const res = await call(app, { feature_key: "o/r#live" });
  assertEquals(res.status, 409);
  assertEquals(res.body.ok, false);
  assertEquals(rows[0].acknowledged_at, null);
  assertEquals(rows[0].list_bucket, "active");
});

test("acknowledge-done: a converging (redispatch-terminal but live) run → 409", async () => {
  const { app, rows } = memApp([{ feature_key: "o/r#conv", status: "converging", converge: 1, auto_merge: 1, acknowledged_at: null }]);
  const res = await call(app, { feature_key: "o/r#conv" });
  assertEquals(res.status, 409);
  assertEquals(rows[0].acknowledged_at, null);
});
