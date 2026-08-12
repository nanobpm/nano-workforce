// Red/green for the plan-review gate (issue #86).
//
// The fan-out must never dispatch an unapproved plan automatically. When the per-epoch review cap
// is reached without approval, record-plan-review now emits `planEscalated` so BPMN parks for a
// human directive instead of throwing an unhandled incident or proceeding silently.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { noopLog } from "../../test/log.ts";
import { MAX_PLAN_REVIEW_ROUNDS, type PlanReview } from "../../app/plan.ts";
import handler from "./worker.ts";

function fakeApp(existing: PlanReview[] = [], reviewEscalations: any[] = []) {
  const reviewRows: PlanReview[] = [...existing];
  const escalationRows = [...reviewEscalations];
  const match = (r: Record<string, unknown>, q: Record<string, unknown>) =>
    Object.entries(q).every(([f, v]) => r[f] === v);
  const table = (rows: any[]) => ({
    find: (q: any) => Promise.resolve(rows.filter((r) => match(r, q))),
    findOne: (q: any) => Promise.resolve(rows.find((r) => match(r, q)) ?? null),
    count: (q: any) => Promise.resolve(rows.filter((r) => match(r, q)).length),
    insert: (row: any) => {
      rows.push(row);
      return Promise.resolve(row);
    },
  });
  return {
    data: {
      table(name: string) {
        if (name === "plan_review_escalations") return table(escalationRows);
        return table(reviewRows);
      },
    },
    log: noopLog(),
    _rows: reviewRows,
    _escalations: escalationRows,
  } as any;
}

// Seed `n` prior recorded rounds for a plan/epoch so the next job lands on round `n` (0-based).
function priorRounds(planKey: string, n: number, epoch = 0): PlanReview[] {
  return Array.from({ length: n }, (_, i) => ({
    plan_key: planKey,
    epoch,
    round: i,
    approved: 0,
    findings: null,
    created_at: "2026-01-01T00:00:00.000Z",
    job_key: `prior-${epoch}-${i}`,
  }));
}

const call = async (app: unknown, vars: Record<string, unknown>, jobKey = "j-new") =>
  await handler({ variables: vars, jobKey } as any, app as any);

test("approved round proceeds (planApproved=true, no escalation)", async () => {
  const app = fakeApp(priorRounds("o/r#1", 0));
  const out = await call(app, { planKey: "o/r#1", approved: true });
  assertEquals((out as any).planApproved, true);
  assertEquals((out as any).planEscalated, false);
});

test("unapproved, non-final round revises (planApproved=false, no escalation)", async () => {
  // First round of a 3-round cap: not final, so revise.
  const app = fakeApp(priorRounds("o/r#2", 0));
  const out = await call(app, { planKey: "o/r#2", approved: false, findings: "fix X" });
  assertEquals((out as any).planApproved, false);
  assertEquals((out as any).planEscalated, false);
  assertEquals((out as any).planFindings, "fix X");
});

test("unapproved FINAL round escalates instead of throwing or proceeding", async () => {
  // Seed cap-1 prior rounds so this job is the last permitted round; unapproved ⇒ human escalation.
  const app = fakeApp(priorRounds("o/r#3", MAX_PLAN_REVIEW_ROUNDS - 1));
  const out = await call(app, { planKey: "o/r#3", approved: false, findings: "still wrong" });
  assertEquals((out as any).planApproved, false);
  assertEquals((out as any).planEscalated, true);
  assertEquals((out as any).planReviewRound, MAX_PLAN_REVIEW_ROUNDS - 1);
  assertEquals((out as any).planFindings, "still wrong");
});

test("approved on the FINAL round still proceeds (no escalation)", async () => {
  const app = fakeApp(priorRounds("o/r#4", MAX_PLAN_REVIEW_ROUNDS - 1));
  const out = await call(app, { planKey: "o/r#4", approved: true });
  assertEquals((out as any).planApproved, true);
  assertEquals((out as any).planEscalated, false);
});

test("answered plan-review escalation starts a fresh epoch and round budget", async () => {
  const app = fakeApp(
    priorRounds("o/r#5", MAX_PLAN_REVIEW_ROUNDS, 0),
    [{ id: 1, plan_key: "o/r#5", status: "answered" }],
  );
  const out = await call(app, { planKey: "o/r#5", approved: false, findings: "new epoch finding" });
  assertEquals((out as any).planApproved, false);
  assertEquals((out as any).planEscalated, false);
  assertEquals((out as any).planReviewEpoch, 1);
  assertEquals((out as any).planReviewRound, 0);
  assertEquals(app._rows.at(-1).epoch, 1);
  assertEquals(app._rows.at(-1).round, 0);
});
