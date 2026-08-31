// Tests for the POST /app/api/actions/acknowledge-pr operation `acknowledgePr` (issue #641, #652).
// The nwf UI's "Dismiss" (Done ✓) affordance for a TERMINAL pull request. It stamps `acknowledged_at`,
// which the `pull_requests_read_model` VIEW (094) derives into `list_bucket` = 'history' and `ack_open`
// = 0, dropping the finished PR from the Active convergence list into History. Unlike acknowledge-
// blocked it completes NO user task (a terminal PR is not parked). The PR twin of acknowledge-done /
// acknowledge-epic.
//
// The op's only write is the `acknowledged_at` (+ `updated_at`) stamp on the base `pull_requests` row,
// gated on the TERMINAL tier (`PR_TERMINAL_STATUSES`) — but read off the `pull_requests_read_model`
// VIEW's FOLDED/effective `status` (issue #652), the SAME source of truth the Dismiss affordance
// (`ack_open`) derives from, NOT the frozen base column. These tests seed an in-memory read model +
// base store and assert the 400/404/409/200 gate + the stamp; the bucket derivation itself is proven
// in app/pullRequestReadModel.test.ts.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";
import { PR_TERMINAL_STATUSES, PULL_REQUEST_READ_MODEL_NAME } from "../app/pullRequestReadModel.ts";
import handler from "./acknowledgePr.ts";

// A read model row (folded/effective `status` the op gates on) and its base `pull_requests` row (the
// stamp target). `derivedStatus` folds over `status` exactly as `COALESCE(pr.derived_status, pr.status)`
// does in the 094 VIEW, so a seed can model an out-of-band-terminated PR (base `escalated`, folded
// `abandoned`) — the #652 drift case.
type Seed = { prKey: string; status: string; derivedStatus?: string; acknowledgedAt?: string | null };

// biome-ignore lint/suspicious/noExplicitAny: test-only fake data layer over dynamic row shapes.
function memApp(seeds: Seed[]): { app: AppApi; base: any[] } {
  // biome-ignore lint/suspicious/noExplicitAny: test-only store.
  const base: any[] = seeds.map((s) => ({
    pr_key: s.prKey,
    status: s.status,
    acknowledged_at: s.acknowledgedAt ?? null,
  }));
  // The read model VIEW exposes the folded effective status as `status` (COALESCE(derived_status, status)).
  // biome-ignore lint/suspicious/noExplicitAny: test-only store.
  const readModel: any[] = seeds.map((s) => ({
    pr_key: s.prKey,
    status: s.derivedStatus ?? s.status,
  }));
  // biome-ignore lint/suspicious/noExplicitAny: test-only store.
  const stores: Record<string, any[]> = { pull_requests: base, [PULL_REQUEST_READ_MODEL_NAME]: readModel };
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
  return { app, base };
}

async function call(app: AppApi, body: unknown) {
  // biome-ignore lint/suspicious/noExplicitAny: test-only op invocation.
  return (await handler({ req: {} as any, params: {}, query: {}, body } as any, app)) as any;
}

test("acknowledge-pr: stamps acknowledged_at on a terminal PR and returns 200", async () => {
  const { app, base } = memApp([{ prKey: "o/r#1", status: "merged" }]);
  const res = await call(app, { pr_key: "o/r#1" });
  assertEquals(res.status, 200);
  assertEquals(res.body.ok, true);
  assertEquals(typeof base[0].acknowledged_at, "string");
  assertEquals(typeof base[0].updated_at, "string");
});

test("acknowledge-pr: every terminal status is dismissable", async () => {
  for (const status of PR_TERMINAL_STATUSES) {
    const { app, base } = memApp([{ prKey: "o/r#1", status }]);
    const res = await call(app, { pr_key: "o/r#1" });
    assertEquals(res.status, 200, `status ${status} must be dismissable`);
    assertEquals(typeof base[0].acknowledged_at, "string");
  }
});

// Issue #652 — the drift case. A PR terminated OUT OF BAND leaves base `status` frozen at its last
// transient (`escalated`) while the tracking VIEW folds `derived_status` to `abandoned`, so the read
// model reports the effective `status = abandoned` and lights `ack_open`. Gating on the base column
// (the old bug) 409'd "pull request is not terminal" on exactly the row the UI shows Dismiss on;
// gating on the folded read-model status accepts it.
test("acknowledge-pr: an out-of-band-terminated PR (base escalated, folded abandoned) is dismissable (200)", async () => {
  const { app, base } = memApp([{ prKey: "o/r#1716", status: "escalated", derivedStatus: "abandoned" }]);
  const res = await call(app, { pr_key: "o/r#1716" });
  assertEquals(res.status, 200);
  assertEquals(res.body.ok, true);
  assertEquals(typeof base[0].acknowledged_at, "string");
  // The base row's frozen transient is NOT rewritten — only the acknowledgement is stamped; the VIEW
  // folds it to History (list_bucket = 'history', ack_open = 0) off derived_status + acknowledged_at.
  assertEquals(base[0].status, "escalated");
});

test("acknowledge-pr: a live (still-converging) PR is rejected (409) and stays unstamped", async () => {
  const { app, base } = memApp([{ prKey: "o/r#2", status: "converging" }]);
  const res = await call(app, { pr_key: "o/r#2" });
  assertEquals(res.status, 409);
  assertEquals(res.body.ok, false);
  assertEquals(base[0].acknowledged_at, null);
});

// A genuinely live PR whose engine instance is still ACTIVE has `derived_status === status` (a live PR
// has no terminal fold), so the read model reports the live transient — still not terminal → 409.
test("acknowledge-pr: a live PR awaiting review (instance active, folded == base) is rejected (409)", async () => {
  const { app, base } = memApp([{ prKey: "o/r#3", status: "waiting_review", derivedStatus: "waiting_review" }]);
  const res = await call(app, { pr_key: "o/r#3" });
  assertEquals(res.status, 409);
  assertEquals(base[0].acknowledged_at, null);
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
  const { app, base } = memApp([{ prKey: "o/r#5", status: "converged" }]);
  assertEquals((await call(app, { pr_key: "o/r#5" })).status, 200);
  assertEquals(typeof base[0].acknowledged_at, "string");
  assertEquals((await call(app, { pr_key: "o/r#5" })).status, 200);
  assertEquals(typeof base[0].acknowledged_at, "string");
});
