// Tests for GET /app/api/prs/history → operation `getPrHistory` (issue #668, N4 of epic #664).
// The headline scenario: a PR that escalated and then RESUMED (its escalation answered, a fresh round
// recorded) exposes its full history — every round's status/outcome plus the answered escalation's
// question/answer — through the tool, with NO DB access (the handler reads the same `rounds`/
// `escalations` tables the Convergence page surfaces, via a minimal in-memory DataLayer). Also covers
// the processKey → prKey resolution, the prKey/processKey-required 400, and the shared-secret guard.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";
import handler from "./getPrHistory.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-only dynamic row shapes.
type Row = any;

function memApp(tables: { rounds?: Row[]; escalations?: Row[]; pull_requests?: Row[] }): AppApi {
  const stores: Record<string, Row[]> = {
    rounds: tables.rounds ?? [],
    escalations: tables.escalations ?? [],
    pull_requests: tables.pull_requests ?? [],
  };
  const table = (name: string) => ({
    async find(where: Record<string, unknown>) {
      return (stores[name] ?? []).filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
    },
  });
  return { data: { table }, log: noopLog() } as unknown as AppApi;
}

function input(query: Record<string, string>, headers: Record<string, string> = {}) {
  return {
    req: {
      method: "GET",
      path: "/app/api/prs/history",
      query: new URLSearchParams(query),
      headers: new Headers(headers),
      text: async () => "",
    } as unknown,
    params: {},
    query,
    body: undefined,
  };
}

// A PR that escalated in round 1 (blocker), had that escalation answered, and RESUMED into round 2.
function escalatedThenResumed() {
  return memApp({
    pull_requests: [{ pr_key: "o/r#7", process_key: "proc-7" }],
    rounds: [
      { id: 10, pr_key: "o/r#7", round_no: 1, status: "needs_input", summary: "hit an ambiguity", worker: "senior-a", started_at: "2026-03-01T00:00:00Z", ended_at: "2026-03-01T00:05:00Z" },
      { id: 11, pr_key: "o/r#7", round_no: 2, status: "converged", summary: "resolved after the answer", worker: "senior-a", started_at: "2026-03-01T01:00:00Z", ended_at: "2026-03-01T01:05:00Z" },
    ],
    escalations: [
      { id: 20, pr_key: "o/r#7", round_no: 1, kind: "blocker", question: "Which base branch?", answer: "main", status: "answered", worker: "senior-a", asked_at: "2026-03-01T00:03:00Z", answered_at: "2026-03-01T00:50:00Z" },
    ],
  });
}

test("an escalated-then-resumed PR exposes its round + escalation history by prKey", async () => {
  const res = (await handler(input({ prKey: "o/r#7" }), escalatedThenResumed())) as Row;
  assertEquals(res.status, 200);
  assertEquals(res.body.prKey, "o/r#7");

  // Both rounds surface, in round order, with their status transition + outcome summary.
  assertEquals(res.body.rounds.length, 2);
  assertEquals(res.body.rounds[0].roundNo, 1);
  assertEquals(res.body.rounds[0].status, "needs_input");
  assertEquals(res.body.rounds[1].roundNo, 2);
  assertEquals(res.body.rounds[1].status, "converged");
  assertEquals(res.body.rounds[1].summary, "resolved after the answer");

  // The escalation surfaces with its kind, question, answer, and timestamps — the "why did it
  // escalate / what was answered" the tool exists to expose.
  assertEquals(res.body.escalations.length, 1);
  const e = res.body.escalations[0];
  assertEquals(e.kind, "blocker");
  assertEquals(e.question, "Which base branch?");
  assertEquals(e.answer, "main");
  assertEquals(e.status, "answered");
  assertEquals(e.roundNo, 1);
  assertEquals(e.askedAt, "2026-03-01T00:03:00Z");
  assertEquals(e.answeredAt, "2026-03-01T00:50:00Z");
});

test("resolves the PR by processKey when no prKey is given", async () => {
  const res = (await handler(input({ processKey: "proc-7" }), escalatedThenResumed())) as Row;
  assertEquals(res.status, 200);
  assertEquals(res.body.prKey, "o/r#7");
  assertEquals(res.body.rounds.length, 2);
  assertEquals(res.body.escalations.length, 1);
});

test("orders rounds by round_no and escalations in asked order", async () => {
  const app = memApp({
    rounds: [
      { id: 2, pr_key: "o/r#9", round_no: 2, status: "converged", summary: null, worker: null, started_at: "b", ended_at: null },
      { id: 1, pr_key: "o/r#9", round_no: 1, status: "addressed", summary: null, worker: null, started_at: "a", ended_at: null },
    ],
    escalations: [
      { id: 5, pr_key: "o/r#9", round_no: 2, kind: "question", question: "second", answer: null, status: "open", worker: null, asked_at: "b", answered_at: null },
      { id: 4, pr_key: "o/r#9", round_no: 1, kind: "question", question: "first", answer: null, status: "answered", worker: null, asked_at: "a", answered_at: "a2" },
    ],
  });
  const res = (await handler(input({ prKey: "o/r#9" }), app)) as Row;
  assertEquals(res.body.rounds.map((r: Row) => r.roundNo), [1, 2]);
  assertEquals(res.body.escalations.map((e: Row) => e.question), ["first", "second"]);
});

test("an unknown PR returns an empty history (not a 404)", async () => {
  const res = (await handler(input({ prKey: "o/r#404" }), memApp({}))) as Row;
  assertEquals(res.status, 200);
  assertEquals(res.body.prKey, "o/r#404");
  assertEquals(res.body.rounds, []);
  assertEquals(res.body.escalations, []);
});

test("neither prKey nor processKey → 400", async () => {
  const res = (await handler(input({}), memApp({}))) as Row;
  assertEquals(res.status, 400);
});

test("shared-secret guard rejects a missing/wrong secret when configured", async () => {
  const prev = process.env["NANO_PR_WEBHOOK_SECRET"];
  process.env["NANO_PR_WEBHOOK_SECRET"] = "s3cr3t";
  try {
    const mod = await import(`./getPrHistory.ts?guard=${Date.now()}`);
    const guarded = mod.default as typeof handler;
    const bad = (await guarded(input({ prKey: "o/r#7" }), escalatedThenResumed())) as Row;
    assertEquals(bad.status, 401);
    const ok = (await guarded(input({ prKey: "o/r#7" }, { "x-hook-secret": "s3cr3t" }), escalatedThenResumed())) as Row;
    assertEquals(ok.status, 200);
    assert(Array.isArray(ok.body.rounds));
  } finally {
    if (prev === undefined) delete process.env["NANO_PR_WEBHOOK_SECRET"];
    else process.env["NANO_PR_WEBHOOK_SECRET"] = prev;
  }
});
