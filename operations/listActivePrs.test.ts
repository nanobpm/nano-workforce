// Tests for GET /app/api/status → operation `listActivePrs` (ADR 0058 OpenAPI surface).
// Covers the happy path (count/prs projection) and the optional shared-secret guard. A minimal
// in-memory DataLayer backs `activePrs` (it reads the `pull_requests` table via `.all()`).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";
import handler from "./listActivePrs.ts";

function memApp(rows: any[], escalations: any[] = []): AppApi {
  const table = (name: string) => {
    if (name === "escalations") {
      return {
        async find(where: Record<string, unknown>) {
          return escalations.filter((e) =>
            Object.entries(where).every(([k, v]) => e[k] === v)
          );
        },
      };
    }
    return {
      async all() {
        return rows;
      },
    };
  };
  return { data: { table }, log: noopLog() } as any as AppApi;
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

test("surfaces openEscalation for an escalated PR from its open escalations row (both loops)", async () => {
  // Regression: a merge-loop escalation parks on a message catch (no user task), so deriving
  // openEscalation from a user-task probe hid it. Deriving from the canonical `escalations` row
  // surfaces it. Two escalated PRs — one with an open row (visible), one already answered (null).
  const app = memApp(
    [
      { pr_key: "o/r#10", repo: "o/r", number: 10, url: "u10", title: "merge blocked", status: "escalated", current_round: 3, process_key: "m1", updated_at: "2026-02-02" },
      { pr_key: "o/r#11", repo: "o/r", number: 11, url: "u11", title: "answered", status: "escalated", current_round: 4, process_key: "m2", updated_at: "2026-02-01" },
    ],
    [
      { id: 1, pr_key: "o/r#10", status: "open", question: "Resolve the conflict on the branch, then retry?" },
      { id: 2, pr_key: "o/r#11", status: "answered", question: "old question" },
    ],
  );
  const res = (await handler(input(), app)) as any;
  assertEquals(res.status, 200);
  const p10 = res.body.prs.find((p: any) => p.prKey === "o/r#10");
  const p11 = res.body.prs.find((p: any) => p.prKey === "o/r#11");
  assertEquals(p10.openEscalation, "Resolve the conflict on the branch, then retry?");
  assertEquals(p11.openEscalation, null);
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
