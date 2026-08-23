// Tests for GET /app/api/lineage → operation `getLineage` (issue #245). Covers the stitched list
// projection, the `root` narrowing, an unknown root (empty), and the optional shared-secret guard.
// A minimal in-memory DataLayer backs the derivation (it reads the feature_runs / plans / plan_tasks
// / pull_requests tables via `.all()` / `.find()`).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";
import { withTrackingViews } from "../test/trackingViews.ts";
import handler from "./getLineage.ts";

function memApp(stores: Record<string, any[]>): AppApi {
  const table = (name: string) => {
    const rows = stores[name] ?? [];
    return {
      async all() {
        return rows.slice();
      },
      async find(where: Record<string, unknown> = {}) {
        return rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
      },
    };
  };
  return { data: { table: withTrackingViews(table) }, log: noopLog() } as any as AppApi;
}

function input(query: Record<string, string> = {}, headers: Record<string, string> = {}) {
  return {
    req: {
      method: "GET",
      path: "/app/api/lineage",
      query: new URLSearchParams(query),
      headers: new Headers(headers),
      text: async () => "",
    } as any,
    params: {},
    query,
    body: undefined,
  };
}

function fixture(): Record<string, any[]> {
  return {
    feature_runs: [
      { feature_key: "o/r#1", title: "Feature", issue_url: "u1", status: "converging", process_key: "f1", pr_key: "o/r#100" },
    ],
    plans: [
      { plan_key: "o/r#2", title: "Epic", issue_url: "u2", status: "done", process_key: "e1" },
    ],
    plan_tasks: [
      { id: 1, plan_key: "o/r#2", pr_key: "o/r#200" },
      { id: 2, plan_key: "o/r#2", pr_key: "o/r#201" },
    ],
    pull_requests: [
      { pr_key: "o/r#100", title: "Feat PR", url: "x", status: "converging", current_round: 2, process_key: "c1", outcome: null, root_request_key: "o/r#1" },
      { pr_key: "o/r#200", title: "S1", url: "x", status: "merged", current_round: 1, process_key: "c2", outcome: null, root_request_key: "o/r#2" },
      { pr_key: "o/r#201", title: "S2", url: "x", status: "converging", current_round: 1, process_key: "c3", outcome: null, root_request_key: "o/r#2" },
      { pr_key: "o/r#300", title: "Human PR", url: "x", status: "merged", current_round: 1, process_key: "c4", outcome: null, root_request_key: null },
    ],
  };
}

test("lists every stitched thread, active frontier first", async () => {
  const res = (await handler(input(), memApp(fixture()))) as any;
  assertEquals(res.status, 200);
  assertEquals(res.body.count, 3);
  // Active threads (feature + epic) sort ahead of the settled human PR.
  assert(res.body.threads[res.body.threads.length - 1].active === false);
  const kinds = res.body.threads.map((t: any) => t.kind).sort();
  assertEquals(kinds, ["epic", "feature", "pr"]);
});

test("narrows to a single origin thread via ?root=", async () => {
  const res = (await handler(input({ root: "o/r#2" }), memApp(fixture()))) as any;
  assertEquals(res.status, 200);
  assertEquals(res.body.count, 1);
  const t = res.body.threads[0];
  assertEquals(t.kind, "epic");
  assertEquals(t.rootRequestKey, "o/r#2");
  assertEquals(t.prCount, 2);
});

test("unknown root returns an empty thread list", async () => {
  const res = (await handler(input({ root: "o/r#999" }), memApp(fixture()))) as any;
  assertEquals(res.status, 200);
  assertEquals(res.body.count, 0);
  assertEquals(res.body.threads, []);
});

test("shared-secret guard rejects a missing secret when configured", async () => {
  const prev = process.env["NANO_PR_WEBHOOK_SECRET"];
  process.env["NANO_PR_WEBHOOK_SECRET"] = "s3cr3t";
  try {
    const mod = await import(`./getLineage.ts?guard=${Date.now()}`);
    const guarded = mod.default as typeof handler;
    const app = memApp(fixture());
    const bad = (await guarded(input(), app)) as any;
    assertEquals(bad.status, 401);
    const ok = (await guarded(input({}, { "x-hook-secret": "s3cr3t" }), app)) as any;
    assertEquals(ok.status, 200);
    assert("count" in ok.body);
  } finally {
    if (prev === undefined) delete process.env["NANO_PR_WEBHOOK_SECRET"];
    else process.env["NANO_PR_WEBHOOK_SECRET"] = prev;
  }
});
