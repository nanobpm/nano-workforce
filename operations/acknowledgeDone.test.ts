// Tests for the POST /app/api/actions/acknowledge-done operation `acknowledgeDone` (issue #254 §5).
// The nwf UI's "tick off" affordance for a TERMINAL feature run: it stamps `acknowledged_at`, which
// the `feature_read_model` VIEW (065, issue #439) derives into `list_bucket` = 'history', dropping the
// run from Active into History. Unlike acknowledgeBlocked it completes NO user task (a terminal run is
// not parked). Since `list_bucket` is now a VIEW over `status`/`acknowledged_at` (no stored column),
// these tests assert the operation's real write — the `acknowledged_at` stamp — and cross-check the
// resulting bucket through the pure `deriveListBucket` oracle the VIEW mirrors.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { deriveListBucket } from "../app/stage.ts";
import { noopLog } from "../test/log.ts";
import handler from "./acknowledgeDone.ts";

// An in-memory data layer wired through the `featureRuns` gateway (now a plain record table), so the
// test exercises the operation's write path exactly as production does.
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

test("acknowledge-done: stamps acknowledged_at and (via the VIEW) buckets a terminal row into History", async () => {
  const { app, rows } = memApp([{ feature_key: "o/r#1", status: "merged", converge: 1, auto_merge: 1, acknowledged_at: null }]);
  // Before dismissal a terminal-but-unacknowledged run reads as Active through the VIEW.
  assertEquals(deriveListBucket(rows[0].status, rows[0].acknowledged_at), "active");

  const res = await call(app, { feature_key: "o/r#1" });

  assertEquals(res.status, 200);
  assertEquals(res.body.ok, true);
  assertEquals(typeof rows[0].acknowledged_at, "string");
  // The op's only write is the stamp; the VIEW derives 'history' from (terminal status + acknowledged).
  assertEquals(deriveListBucket(rows[0].status, rows[0].acknowledged_at), "history");
});

test("acknowledge-done: idempotent-safe — re-acknowledging keeps the row in History", async () => {
  const { app, rows } = memApp([{ feature_key: "o/r#2", status: "failed", converge: 1, auto_merge: 1, acknowledged_at: null }]);
  const first = await call(app, { feature_key: "o/r#2" });
  assertEquals(first.status, 200);
  assertEquals(deriveListBucket(rows[0].status, rows[0].acknowledged_at), "history");
  const firstStamp = rows[0].acknowledged_at;
  // Re-acknowledge — still 200, still history.
  const second = await call(app, { feature_key: "o/r#2" });
  assertEquals(second.status, 200);
  assertEquals(deriveListBucket(rows[0].status, rows[0].acknowledged_at), "history");
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
  const res = await call(app, { feature_key: "o/r#live" });
  assertEquals(res.status, 409);
  assertEquals(res.body.ok, false);
  assertEquals(rows[0].acknowledged_at, null);
  // A live run stays Active through the VIEW (no stamp → not History).
  assertEquals(deriveListBucket(rows[0].status, rows[0].acknowledged_at), "active");
});

test("acknowledge-done: a converging (redispatch-terminal but live) run → 409", async () => {
  const { app, rows } = memApp([{ feature_key: "o/r#conv", status: "converging", converge: 1, auto_merge: 1, acknowledged_at: null }]);
  const res = await call(app, { feature_key: "o/r#conv" });
  assertEquals(res.status, 409);
  assertEquals(rows[0].acknowledged_at, null);
});
