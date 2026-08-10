// biome-ignore-all lint/suspicious/noExplicitAny: existing tests use intentionally partial Urban test doubles.
// biome-ignore-all lint/plugin: existing tests use framework-boundary type assertions.
// biome-ignore-all lint/suspicious/noAssignInExpressions: tests use compact in-memory store helpers.
// biome-ignore-all lint/style/noNonNullAssertion: tests assert known fixture state.
// biome-ignore-all lint/complexity/useLiteralKeys: tests use string keys to mirror persisted field names.
// biome-ignore-all lint/correctness/noUnusedFunctionParameters: test doubles preserve framework callback shapes.
// biome-ignore-all lint/correctness/noUnusedVariables: tests keep named captures for readability.
// biome-ignore-all lint/complexity/useOptionalChain: tests keep explicit assertions for fixture state.
// biome-ignore-all assist/source/organizeImports: tests keep imports grouped by fixture role.
// Tests for GET /app/api/status → operation `listActivePrs` (ADR 0058 OpenAPI surface).
// Covers the happy path (count/prs projection) and the optional shared-secret guard. A minimal
// in-memory DataLayer backs `activePrs` (it reads the `pull_requests` table via `.all()`).
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { AppApi } from "@nanobpm/urban";
import handler from "./listActivePrs.ts";

// deno-lint-ignore no-explicit-any
function memApp(rows: any[]): AppApi {
  const tbl = {
    // deno-lint-ignore require-await
    async all() {
      return rows;
    },
  };
  // deno-lint-ignore no-explicit-any
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
      // deno-lint-ignore no-explicit-any
    } as any,
    params: {},
    query: {},
    body: undefined,
  };
}

Deno.test("returns 200 with a count + projected active PRs", async () => {
  const app = memApp([
    { pr_key: "o/r#1", repo: "o/r", number: 1, url: "u1", title: "t", status: "converging", current_round: 2, process_key: "9", updated_at: "2026-01-02" },
    { pr_key: "o/r#2", repo: "o/r", number: 2, url: "u2", title: null, status: "converged", current_round: 1, process_key: null, updated_at: "2026-01-01" },
  ]);
  const res = await handler(input(), app);
  // deno-lint-ignore no-explicit-any
  const r = res as any;
  assertEquals(r.status, 200);
  // `converged` is terminal → filtered out, leaving one active PR.
  assertEquals(r.body.count, 1);
  assertEquals(r.body.prs.length, 1);
  assertEquals(r.body.prs[0].prKey, "o/r#1");
  assertEquals(r.body.prs[0].processKey, "9");
});

Deno.test("shared-secret guard rejects a missing secret when configured", async () => {
  const prev = Deno.env.get("NANO_PR_WEBHOOK_SECRET");
  Deno.env.set("NANO_PR_WEBHOOK_SECRET", "s3cr3t");
  try {
    const mod = await import(`./listActivePrs.ts?guard=${Date.now()}`);
    const guarded = mod.default as typeof handler;
    const app = memApp([]);
    // deno-lint-ignore no-explicit-any
    const bad = (await guarded(input(), app)) as any;
    assertEquals(bad.status, 401);
    // deno-lint-ignore no-explicit-any
    const ok = (await guarded(input({ "x-hook-secret": "s3cr3t" }), app)) as any;
    assertEquals(ok.status, 200);
    assert("count" in ok.body);
  } finally {
    if (prev === undefined) Deno.env.delete("NANO_PR_WEBHOOK_SECRET");
    else Deno.env.set("NANO_PR_WEBHOOK_SECRET", prev);
  }
});
