// Tests for the POST /app/api/actions/acknowledge-pr operation `acknowledgePr` (issue #641).
// The nwf UI's "Dismiss" (Done ✓) affordance for a TERMINAL pull request. It stamps `acknowledged_at`,
// which the `pull_requests_read_model` VIEW (094) derives into `list_bucket` = 'history' and `ack_open`
// = 0, dropping the finished PR from the Active convergence list into History. Unlike acknowledge-
// blocked it completes NO user task (a terminal PR is not parked). The PR twin of acknowledge-done /
// acknowledge-epic.
//
// The op's only write is the `acknowledged_at` (+ `updated_at`) stamp, gated on the base `status`
// belonging to the terminal tier (`PR_TERMINAL_STATUSES`). These tests seed an in-memory `pull_requests`
// store and assert the 400/404/409/200 gate + the stamp; the bucket derivation itself is proven in
// app/pullRequestReadModel.test.ts.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";
import { PR_TERMINAL_STATUSES } from "../app/pullRequestReadModel.ts";
import handler from "./acknowledgePr.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-only fake data layer over dynamic row shapes.
function memApp(seed: any[]): { app: AppApi; rows: any[] } {
  // biome-ignore lint/suspicious/noExplicitAny: test-only store.
  const stores: Record<string, any[]> = { pull_requests: seed };
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
  return { app, rows: stores.pull_requests };
}

async function call(app: AppApi, body: unknown) {
  // biome-ignore lint/suspicious/noExplicitAny: test-only op invocation.
  return (await handler({ req: {} as any, params: {}, query: {}, body } as any, app)) as any;
}

test("acknowledge-pr: stamps acknowledged_at on a terminal PR and returns 200", async () => {
  const { app, rows } = memApp([{ pr_key: "o/r#1", status: "merged", acknowledged_at: null }]);
  const res = await call(app, { pr_key: "o/r#1" });
  assertEquals(res.status, 200);
  assertEquals(res.body.ok, true);
  assertEquals(typeof rows[0].acknowledged_at, "string");
  assertEquals(typeof rows[0].updated_at, "string");
});

test("acknowledge-pr: every terminal status is dismissable", async () => {
  for (const status of PR_TERMINAL_STATUSES) {
    const { app, rows } = memApp([{ pr_key: "o/r#1", status, acknowledged_at: null }]);
    const res = await call(app, { pr_key: "o/r#1" });
    assertEquals(res.status, 200, `status ${status} must be dismissable`);
    assertEquals(typeof rows[0].acknowledged_at, "string");
  }
});

test("acknowledge-pr: a live (still-converging) PR is rejected (409) and stays unstamped", async () => {
  const { app, rows } = memApp([{ pr_key: "o/r#2", status: "converging", acknowledged_at: null }]);
  const res = await call(app, { pr_key: "o/r#2" });
  assertEquals(res.status, 409);
  assertEquals(res.body.ok, false);
  assertEquals(rows[0].acknowledged_at, null);
});

test("acknowledge-pr: a missing pr_key → 400", async () => {
  const { app } = memApp([]);
  assertEquals((await call(app, {})).status, 400);
  assertEquals((await call(app, { pr_key: "  " })).status, 400);
});

test("acknowledge-pr: no matching PR → 404", async () => {
  const { app } = memApp([]);
  assertEquals((await call(app, { pr_key: "o/r#404" })).status, 404);
});

test("acknowledge-pr: idempotent — re-acknowledging a terminal PR re-stamps and returns 200", async () => {
  const { app, rows } = memApp([{ pr_key: "o/r#5", status: "converged", acknowledged_at: null }]);
  assertEquals((await call(app, { pr_key: "o/r#5" })).status, 200);
  assertEquals(typeof rows[0].acknowledged_at, "string");
  assertEquals((await call(app, { pr_key: "o/r#5" })).status, 200);
  assertEquals(typeof rows[0].acknowledged_at, "string");
});
