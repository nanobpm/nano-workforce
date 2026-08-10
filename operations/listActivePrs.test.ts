// Tests for GET /app/api/status → operation `listActivePrs` (ADR 0058 OpenAPI surface).
// Covers the happy path (count/prs projection) and the optional shared-secret guard. A minimal
// in-memory DataLayer backs `activePrs` (it reads the `pull_requests` table via `.all()`).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import handler from "./listActivePrs.ts";

function memApp(rows: any[]): AppApi {
  const tbl = {
    async all() {
      return rows;
    },
  };
  return { data: { table: () => tbl } } as any as AppApi;
}

function input(headers: Record<string, string> = {}) {
  return {
    req: {
      method: "GET",
      path: "/app/api/status",
      query: new URLSearchParams(),
      headers: new Headers(headers),
      text: async () => "",
    } as any,
    params: {},
    query: {},
    body: undefined,
  };
}

test("returns 200 with a count + projected active PRs", async () => {
  const app = memApp([
    { pr_key: "o/r#1", repo: "o/r", number: 1, url: "u1", title: "t", status: "converging", current_round: 2, process_key: "9", updated_at: "2026-01-02" },
    { pr_key: "o/r#2", repo: "o/r", number: 2, url: "u2", title: null, status: "converged", current_round: 1, process_key: null, updated_at: "2026-01-01" },
  ]);
  const res = await handler(input(), app);
  const r = res as any;
  assertEquals(r.status, 200);
  // `converged` is terminal → filtered out, leaving one active PR.
  assertEquals(r.body.count, 1);
  assertEquals(r.body.prs.length, 1);
  assertEquals(r.body.prs[0].prKey, "o/r#1");
  assertEquals(r.body.prs[0].processKey, "9");
});

test("shared-secret guard rejects a missing secret when configured", async () => {
  const prev = process.env["NANO_PR_WEBHOOK_SECRET"];
  process.env["NANO_PR_WEBHOOK_SECRET"] = "s3cr3t";
  try {
    const mod = await import(`./listActivePrs.ts?guard=${Date.now()}`);
    const guarded = mod.default as typeof handler;
    const app = memApp([]);
    const bad = (await guarded(input(), app)) as any;
    assertEquals(bad.status, 401);
    const ok = (await guarded(input({ "x-hook-secret": "s3cr3t" }), app)) as any;
    assertEquals(ok.status, 200);
    assert("count" in ok.body);
  } finally {
    if (prev === undefined) delete process.env["NANO_PR_WEBHOOK_SECRET"];
    else process.env["NANO_PR_WEBHOOK_SECRET"] = prev;
  }
});
