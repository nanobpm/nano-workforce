// Tests for the POST /app/api/actions/acknowledge-delivery-graph operation `acknowledgeDeliveryGraph`
// (issue #641). The nwf UI's "Dismiss" (Done ✓) affordance for a TERMINAL delivery-graph run. It stamps
// `acknowledged_at`, which the `delivery_graph_read_model` VIEW (096) derives into `list_bucket` =
// 'history' and `ack_open` = 0, dropping the finished run from the Active list into History. The
// delivery-graph twin of acknowledge-done / acknowledge-epic / acknowledge-pr.
//
// The op's only write is the `acknowledged_at` (+ `updated_at`) stamp, gated on the base `status`
// belonging to the terminal tier (`DELIVERY_GRAPH_TERMINAL_STATUSES`). These tests seed an in-memory
// `delivery_graph_runs` store and assert the 400/404/409/200 gate + the stamp; the bucket derivation
// itself is proven in app/deliveryGraphReadModel.test.ts.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";
import { DELIVERY_GRAPH_TERMINAL_STATUSES } from "../app/deliveryGraphRun.ts";
import handler from "./acknowledgeDeliveryGraph.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-only fake data layer over dynamic row shapes.
function memApp(seed: any[]): { app: AppApi; rows: any[] } {
  // biome-ignore lint/suspicious/noExplicitAny: test-only store.
  const stores: Record<string, any[]> = { delivery_graph_runs: seed };
  function tbl(name: string, pk = "id") {
    // biome-ignore lint/suspicious/noExplicitAny: test-only.
    const rows = (stores[name] ??= [] as any[]);
    return {
      // biome-ignore lint/suspicious/noExplicitAny: test-only.
      async get(id: any) {
        return rows.find((r) => r[pk] === id);
      },
      // biome-ignore lint/suspicious/noExplicitAny: test-only.
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
  } as unknown as AppApi;
  return { app, rows: stores.delivery_graph_runs };
}

async function call(app: AppApi, body: unknown) {
  // biome-ignore lint/suspicious/noExplicitAny: test-only op invocation.
  return (await handler({ req: {} as any, params: {}, query: {}, body } as any, app)) as any;
}

test("acknowledge-delivery-graph: stamps acknowledged_at on a terminal run and returns 200", async () => {
  const { app, rows } = memApp([{ run_key: "run-1", status: "done", acknowledged_at: null }]);
  const res = await call(app, { run_key: "run-1" });
  assertEquals(res.status, 200);
  assertEquals(res.body.ok, true);
  assertEquals(typeof rows[0].acknowledged_at, "string");
  assertEquals(typeof rows[0].updated_at, "string");
});

test("acknowledge-delivery-graph: every terminal status is dismissable", async () => {
  for (const status of DELIVERY_GRAPH_TERMINAL_STATUSES) {
    const { app, rows } = memApp([{ run_key: "run-1", status, acknowledged_at: null }]);
    const res = await call(app, { run_key: "run-1" });
    assertEquals(res.status, 200, `status ${status} must be dismissable`);
    assertEquals(typeof rows[0].acknowledged_at, "string");
  }
});

test("acknowledge-delivery-graph: a live (running) run is rejected (409) and stays unstamped", async () => {
  const { app, rows } = memApp([{ run_key: "run-2", status: "running", acknowledged_at: null }]);
  const res = await call(app, { run_key: "run-2" });
  assertEquals(res.status, 409);
  assertEquals(res.body.ok, false);
  assertEquals(rows[0].acknowledged_at, null);
});

test("acknowledge-delivery-graph: a missing run_key → 400", async () => {
  const { app } = memApp([]);
  assertEquals((await call(app, {})).status, 400);
  assertEquals((await call(app, { run_key: "  " })).status, 400);
});

test("acknowledge-delivery-graph: no matching run → 404", async () => {
  const { app } = memApp([]);
  assertEquals((await call(app, { run_key: "run-404" })).status, 404);
});

test("acknowledge-delivery-graph: idempotent — re-acknowledging a terminal run re-stamps and returns 200", async () => {
  const { app, rows } = memApp([{ run_key: "run-5", status: "failed", acknowledged_at: null }]);
  assertEquals((await call(app, { run_key: "run-5" })).status, 200);
  assertEquals(typeof rows[0].acknowledged_at, "string");
  assertEquals((await call(app, { run_key: "run-5" })).status, 200);
  assertEquals(typeof rows[0].acknowledged_at, "string");
});
