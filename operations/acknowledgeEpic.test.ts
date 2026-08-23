// Tests for the POST /app/api/actions/acknowledge-epic operation `acknowledgeEpic` (issue #298).
// The nwf UI's "Dismiss" affordance for a RESOLVED epic — landed (delivery=landed) or
// resolved-not-landed (delivery=null); only still-`converging` epics are rejected. It stamps
// `acknowledged_at`, which the `plan_read_model` VIEW (074, issue #439) derives into `list_bucket` =
// 'history' and `ack_open` = 0, dropping the resolved epic from Active into History. Unlike
// acknowledge-blocked it completes NO user task (a resolved epic is not parked). The epic twin of
// acknowledge-done.
//
// Since epic #412 retired the stored `plans.delivery` column, the op derives the delivery signal at
// READ TIME (`derivePlanDelivery` → the pure `deriveDelivery`) by joining the epic's slice
// `plan_tasks.pr_key` → `pull_requests.status`. So these tests seed `plan_tasks` + `pull_requests`
// (not a `plans.delivery` column) to model a landed / converging / resolved-not-landed epic. Because
// `list_bucket`/`ack_open` are now a VIEW (no stored column), the tests assert the operation's real
// write — the `acknowledged_at` stamp and the 200/409 gate — and cross-check the resulting bucket
// through the pure `deriveEpicBucket` / `epicIsAcknowledgeable` oracles the VIEW mirrors.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { deriveEpicBucket, epicIsAcknowledgeable } from "../app/delivery.ts";
import { noopLog } from "../test/log.ts";
import { withTrackingViews } from "../test/trackingViews.ts";
import handler from "./acknowledgeEpic.ts";

// An in-memory data layer wired through the `plans` gateway (now a plain record table). `extra` seeds
// the join surfaces (`plan_tasks` / `pull_requests`) the read-time delivery derivation reads.
function memApp(
  seed: any[],
  extra: Record<string, any[]> = {},
): { app: AppApi; rows: any[] } {
  const stores: Record<string, any[]> = { plans: seed, ...extra };
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
    data: { table: withTrackingViews((n: string, pk?: string) => tbl(n, pk)) },
    log: noopLog(),
  } as any as AppApi;
  return { app, rows: stores.plans };
}

async function call(app: AppApi, body: unknown) {
  return (await handler({ req: {} as any, params: {}, query: {}, body } as any, app)) as any;
}

test("acknowledge-epic: stamps acknowledged_at and (via the VIEW) buckets a landed epic into History", async () => {
  const { app, rows } = memApp(
    [{ plan_key: "o/r#1", status: "done", acknowledged_at: null }],
    {
      plan_tasks: [{ id: 1, plan_key: "o/r#1", pr_key: "o/r#100" }],
      pull_requests: [{ pr_key: "o/r#100", status: "merged" }], // landed
    },
  );
  // Before dismissal a landed-but-unacknowledged epic reads as Active with Dismiss open through the VIEW.
  assertEquals(deriveEpicBucket("done", "landed", rows[0].acknowledged_at), "active");
  assertEquals(epicIsAcknowledgeable("done", "landed"), true);

  const res = await call(app, { plan_key: "o/r#1" });

  assertEquals(res.status, 200);
  assertEquals(res.body.ok, true);
  assertEquals(typeof rows[0].acknowledged_at, "string");
  // The op's only write is the stamp; the VIEW derives 'history' + ack_open 0 from the acknowledged row.
  assertEquals(deriveEpicBucket("done", "landed", rows[0].acknowledged_at), "history");
});

test("acknowledge-epic: a still-converging epic is rejected (409) and stays Active", async () => {
  const { app, rows } = memApp(
    [{ plan_key: "o/r#2", status: "done", acknowledged_at: null }],
    {
      plan_tasks: [
        { id: 1, plan_key: "o/r#2", pr_key: "o/r#200" },
        { id: 2, plan_key: "o/r#2", pr_key: "o/r#201" },
      ],
      pull_requests: [
        { pr_key: "o/r#200", status: "merged" },
        { pr_key: "o/r#201", status: "converging" }, // still in flight → converging
      ],
    },
  );

  const res = await call(app, { plan_key: "o/r#2" });

  assertEquals(res.status, 409);
  assertEquals(res.body.ok, false);
  // Untouched: no premature acknowledged_at; still Active through the VIEW (converging → active).
  assertEquals(rows[0].acknowledged_at, null);
  assertEquals(deriveEpicBucket("done", "converging", rows[0].acknowledged_at), "active");
});

test("acknowledge-epic: a resolved-not-landed epic (delivery=null) is accepted (200) and flips to History", async () => {
  const { app, rows } = memApp(
    [{ plan_key: "o/r#2b", status: "done", acknowledged_at: null }],
    {
      plan_tasks: [
        { id: 1, plan_key: "o/r#2b", pr_key: "o/r#210" },
        { id: 2, plan_key: "o/r#2b", pr_key: "o/r#211" },
      ],
      pull_requests: [
        { pr_key: "o/r#210", status: "merged" },
        { pr_key: "o/r#211", status: "abandoned" }, // all terminal, not all merged → delivery null
      ],
    },
  );
  assertEquals(deriveEpicBucket("done", null, rows[0].acknowledged_at), "active");
  assertEquals(epicIsAcknowledgeable("done", null), true);

  const res = await call(app, { plan_key: "o/r#2b" });

  assertEquals(res.status, 200);
  assertEquals(res.body.ok, true);
  assertEquals(typeof rows[0].acknowledged_at, "string");
  assertEquals(deriveEpicBucket("done", null, rows[0].acknowledged_at), "history");
});

test("acknowledge-epic: a live (dispatched) epic is rejected (409)", async () => {
  const { app } = memApp([{ plan_key: "o/r#3", status: "dispatched", acknowledged_at: null }]);
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
  const { app, rows } = memApp(
    [{ plan_key: "o/r#5", status: "done", acknowledged_at: null }],
    {
      plan_tasks: [{ id: 1, plan_key: "o/r#5", pr_key: "o/r#500" }],
      pull_requests: [{ pr_key: "o/r#500", status: "merged" }], // landed
    },
  );

  assertEquals((await call(app, { plan_key: "o/r#5" })).status, 200);
  const firstStamp = rows[0].acknowledged_at;
  assertEquals(deriveEpicBucket("done", "landed", rows[0].acknowledged_at), "history");

  const res2 = await call(app, { plan_key: "o/r#5" });
  assertEquals(res2.status, 200);
  assertEquals(deriveEpicBucket("done", "landed", rows[0].acknowledged_at), "history");
  // Re-stamped (a fresh timestamp) but still resolved.
  assertEquals(typeof rows[0].acknowledged_at, "string");
  void firstStamp;
});
