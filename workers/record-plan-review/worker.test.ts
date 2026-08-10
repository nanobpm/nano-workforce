// Red/green for the plan-review gate (issue #86).
//
// Previously the fan-out PROCEEDED when the review-round cap was reached without approval
// ("proceed regardless rather than dead-lock"). That dispatched an un-vetted plan and — when the
// plan was empty (e.g. the planner agent couldn't persist its result) — completed the whole epic
// GREEN having done nothing (instance 21). We now HARD-FAIL: the terminal, unapproved round raises
// a non-retryable `PLAN_REJECTED` BpmnError (→ incident), so an un-approved plan never dispatches.
import { test } from "node:test";
import { assertEquals, assertRejects } from "#test-assert";
import { BpmnError } from "@nanobpm/urban";
import handler from "./worker.ts";
import { MAX_PLAN_REVIEW_ROUNDS, type PlanReview } from "../../app/plan.ts";

function fakeApp(existing: PlanReview[] = []) {
  const rows: PlanReview[] = [...existing];
  const match = (r: PlanReview, q: Record<string, unknown>) =>
    Object.entries(q).every(([f, v]) => (r as unknown as Record<string, unknown>)[f] === v);
  return {
    data: {
      table() {
        return {
          findOne: (q: any) => Promise.resolve(rows.find((r) => match(r, q)) ?? null),
          count: (q: any) => Promise.resolve(rows.filter((r) => match(r, q)).length),
          insert: (row: PlanReview) => {
            rows.push(row);
            return Promise.resolve(row);
          },
        };
      },
    },
    log: () => {},
    _rows: rows,
  } as any;
}

// Seed `n` prior recorded rounds for a plan so the next job lands on round `n` (0-based).
function priorRounds(planKey: string, n: number): PlanReview[] {
  return Array.from({ length: n }, (_, i) => ({
    plan_key: planKey,
    round: i,
    approved: 0,
    findings: null,
    created_at: "2026-01-01T00:00:00.000Z",
    job_key: `prior-${i}`,
  }));
}

const call = async (app: unknown, vars: Record<string, unknown>, jobKey = "j-new") =>
  await handler({ variables: vars, jobKey } as any, app as any);

test("approved round proceeds (planApproved=true, no throw)", async () => {
  const app = fakeApp(priorRounds("o/r#1", 0));
  const out = await call(app, { planKey: "o/r#1", approved: true });
  assertEquals((out as { planApproved: boolean }).planApproved, true);
});

test("unapproved, non-final round revises (planApproved=false, no throw)", async () => {
  // First round of a 3-round cap: not final, so revise.
  const app = fakeApp(priorRounds("o/r#2", 0));
  const out = await call(app, { planKey: "o/r#2", approved: false, findings: "fix X" });
  assertEquals((out as { planApproved: boolean; planFindings: string }).planApproved, false);
  assertEquals((out as { planFindings: string }).planFindings, "fix X");
});

test("unapproved FINAL round hard-fails with PLAN_REJECTED incident", async () => {
  // Seed cap-1 prior rounds so this job is the last permitted round; unapproved ⇒ must throw.
  const app = fakeApp(priorRounds("o/r#3", MAX_PLAN_REVIEW_ROUNDS - 1));
  const err = await assertRejects(
    () => call(app, { planKey: "o/r#3", approved: false, findings: "still wrong" }),
    BpmnError,
  );
  assertEquals((err as BpmnError).errorCode, "PLAN_REJECTED");
});

test("approved on the FINAL round still proceeds (no throw)", async () => {
  const app = fakeApp(priorRounds("o/r#4", MAX_PLAN_REVIEW_ROUNDS - 1));
  const out = await call(app, { planKey: "o/r#4", approved: true });
  assertEquals((out as { planApproved: boolean }).planApproved, true);
});
