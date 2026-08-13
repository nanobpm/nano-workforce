// Red/green regression for answerEscalation (merge-loop message path) — Copilot review of PR #180.
//
// `pr.persist-escalation` always INSERTs a fresh `escalations` row with `status="open"`, so a
// retry/duplicate activation can leave more than one open row for the same PR. answerEscalation
// only closed the NEWEST open row, leaving older duplicates `open` — a phantom that keeps
// `activePrs` deriving an open escalation while the PR is still `escalated`. Every open row for the
// PR must leave `open` in this completion (newest answered, the rest marked `stale`), exactly as
// `submitPr`'s resubmit cleanup already does. Mirrors the review loop's `pr.answer-escalation`.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import { answerEscalation } from "./service.ts";

function memData(escalations: any[], prs: any[]): DataLayer {
  const table = (name: string, key: string) => ({
    async find(where: Record<string, unknown>) {
      const src = name === "escalations" ? escalations : prs;
      return src.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
    },
    async update(k: unknown, patch: Record<string, unknown>) {
      const src = name === "escalations" ? escalations : prs;
      const r = src.find((x) => x[key] === k);
      if (r) Object.assign(r, patch);
      return r;
    },
  });
  return { table } as any as DataLayer;
}

function fakeEngine(published: any[]): EngineClient {
  return {
    async publishMessage(m: any) {
      published.push(m);
    },
  } as any as EngineClient;
}

test("answerEscalation answers the newest open row and marks duplicate open rows stale", async () => {
  const escalations = [
    { id: 3, pr_key: "o/r#1", status: "open", answer: null, answered_at: null },
    { id: 7, pr_key: "o/r#1", status: "open", answer: null, answered_at: null },
    { id: 9, pr_key: "o/r#2", status: "open", answer: null, answered_at: null },
  ];
  const prs = [{ pr_key: "o/r#1", status: "escalated", updated_at: "t0" }];
  const published: any[] = [];
  const res = await answerEscalation(memData(escalations, prs), fakeEngine(published), "o/r#1", "Cap at 5.");

  assertEquals(res, { ok: true, escalationId: 7 }, "the newest open row is the one answered");
  const answered = escalations.find((e) => e.id === 7);
  const stale = escalations.find((e) => e.id === 3);
  const other = escalations.find((e) => e.id === 9);
  assertEquals(answered?.status, "answered");
  assertEquals(answered?.answer, "Cap at 5.");
  assertEquals(stale?.status, "stale", "the older duplicate open row is retired to stale");
  assertEquals(other?.status, "open", "the other PR's open row is untouched");
  assertEquals(prs[0].status, "converging", "the PR row is moved off escalated");
  assertEquals(published.length, 1, "the resume message is published once");
  assertEquals(published[0].variables.escalationId, 7);
});

test("answerEscalation is a no-op when no row is open", async () => {
  const escalations = [{ id: 7, pr_key: "o/r#1", status: "answered", answer: "x", answered_at: "t" }];
  const published: any[] = [];
  const res = await answerEscalation(memData(escalations, []), fakeEngine(published), "o/r#1", "again");
  assertEquals(res, { ok: false, reason: "no open escalation" });
  assertEquals(published.length, 0);
});
