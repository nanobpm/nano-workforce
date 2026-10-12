// Tests for GET /app/api/status → operation `listActivePrs` (ADR 0058 OpenAPI surface).
// Covers the happy path (count/prs projection) and the optional shared-secret guard. A minimal
// in-memory DataLayer backs `activePrs` (it reads the `pull_requests` table via `.all()`).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";
import { withTrackingViews } from "../test/trackingViews.ts";
import handler from "./listActivePrs.ts";

function memApp(rows: any[], userTaskRows: any[] = [], deliveryRows: any[] = []): AppApi {
  const table = (name: string) => {
    if (name === "user_tasks") {
      return {
        async all() {
          return userTaskRows;
        },
        async find(where: Record<string, unknown>) {
          return userTaskRows.filter((t) => Object.entries(where).every(([k, v]) => t[k] === v));
        },
      };
    }
    if (name === "delivery_graph_runs") {
      return {
        async all() {
          return deliveryRows;
        },
      };
    }
    return {
      async all() {
        return rows;
      },
    };
  };
  return { data: { table: withTrackingViews(table) }, log: noopLog() } as any as AppApi;
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

test("surfaces the structured openEscalation from the user_tasks read model (both loops)", async () => {
  // Issue #666: openEscalation is derived from the ONE `user_tasks` read model (the same surface
  // `listEscalations` and the Convergence page consume), so `/status` carries the completable
  // userTaskKey. A `user_tasks` row for a PR subject exists iff its review/merge-loop escalation task
  // is currently open; a PR with no such row derives null. Cover a review-loop and a merge-loop PR.
  const app = memApp(
    [
      { pr_key: "o/r#10", repo: "o/r", number: 10, url: "u10", title: "merge blocked", status: "escalated", current_round: 3, process_key: "m1", updated_at: "2026-02-02" },
      { pr_key: "o/r#11", repo: "o/r", number: 11, url: "u11", title: "no open task", status: "escalated", current_round: 4, process_key: "m2", updated_at: "2026-02-01" },
    ],
    [
      {
        user_task_key: "ut-10",
        element_id: "wait-merge-answer",
        kind_label: "PR merge",
        subject_type: "pr",
        subject_key: "o/r#10",
        subject_title: "merge blocked",
        subject_url: null,
        question: "Resolve the conflict on the branch, then retry?",
        process_key: "m1",
        form_key: null,
        created_at: "2026-02-02",
        updated_at: "2026-02-02",
      },
    ],
  );
  const res = (await handler(input(), app)) as any;
  assertEquals(res.status, 200);
  const p10 = res.body.prs.find((p: any) => p.prKey === "o/r#10");
  const p11 = res.body.prs.find((p: any) => p.prKey === "o/r#11");
  assertEquals(p10.openEscalation, {
    userTaskKey: "ut-10",
    kind: "wait-merge-answer",
    summary: "Resolve the conflict on the branch, then retry?",
  });
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

test("surfaces each in-flight delivery run with its durable escalation-steward opt-in (issue #889 §1)", async () => {
  // `/status` must show the opt-in for each PR AND each delivery. A terminal (`done`) run drops out;
  // a live run carries its durable `auto_resolve_escalations` flag (never a clobbered process var) and
  // its open escalation pointer (derived from the SAME `user_tasks` read model, subject_type
  // "delivery", keyed by run_key).
  const app = memApp(
    [],
    [
      {
        user_task_key: "ut-d1",
        element_id: "delivery-human-taskish",
        kind_label: "Delivery approval",
        subject_type: "delivery",
        subject_key: "run-live",
        subject_title: "Ship it",
        subject_url: null,
        question: "approve the release?",
        process_key: "pk-live",
        form_key: null,
        created_at: "2026-03-02",
        updated_at: "2026-03-02",
      },
    ],
    [
      { run_key: "run-live", process_key: "pk-live", status: "running", phase: "Running", title: "Ship it", auto_resolve_escalations: 1, updated_at: "2026-03-02" },
      { run_key: "run-done", process_key: "pk-done", status: "done", phase: "Done", title: "Old", auto_resolve_escalations: 0, updated_at: "2026-03-01" },
    ],
  );
  const res = (await handler(input(), app)) as any;
  assertEquals(res.status, 200);
  assertEquals(res.body.deliveries.length, 1, "a terminal (done) run drops out of the active list");
  const d = res.body.deliveries[0];
  assertEquals(d.runKey, "run-live");
  assertEquals(d.autoResolveEscalations, true, "the durable opt-in flag is surfaced for the delivery");
  assertEquals(d.processKey, "pk-live");
  assertEquals(d.openEscalation, { userTaskKey: "ut-d1", kind: "delivery-human-taskish", summary: "approve the release?" });
});

test("a delivery run with no opt-in row flag surfaces autoResolveEscalations false and a null escalation", async () => {
  const app = memApp(
    [],
    [],
    [{ run_key: "run-plain", process_key: null, status: "running", phase: null, title: null, auto_resolve_escalations: 0, updated_at: "2026-03-03" }],
  );
  const res = (await handler(input(), app)) as any;
  assertEquals(res.status, 200);
  assertEquals(res.body.deliveries.length, 1);
  assertEquals(res.body.deliveries[0].autoResolveEscalations, false);
  assertEquals(res.body.deliveries[0].openEscalation, null);
  assertEquals(res.body.deliveries[0].processKey, null, "a launch-in-flight run has no stamped process_key yet");
});
