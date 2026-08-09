// pr.record-plan-review — record one adversarial plan-review round and decide whether the
// fan-out proceeds or the planner revises (issue: gate the plan before dispatch).
//
// The `senior:plan-review` agent critiqued the levelized plan and emitted `{ approved, findings }`.
// This worker:
//   • derives the current round from the append-only `plan_reviews` log (no counter variable),
//     using the engine jobKey as an idempotency guard so a retried job reuses its row,
//   • records this round's verdict + findings,
//   • decides the loop: emits `planApproved` (reviewer said yes → the BPMN gateway proceeds to
//     `select-wave`) or, when unapproved, re-emits the findings as `planFindings` so a revise
//     round feeds the planner and loops back to `plan`.
//
// When the review-round cap is reached WITHOUT approval, this worker HARD-FAILS: it throws a
// non-retryable `PLAN_REJECTED` BpmnError (→ incident) rather than proceeding regardless
// (issue #86). Proceeding used to dispatch an un-vetted plan and — when the plan was empty — let
// the whole epic complete GREEN having done nothing. The cap still bounds the loop; it now bounds
// it into an incident, not a silent proceed. A missing/ambiguous `approved` is treated as NOT
// approved (revise until the cap).
import { BpmnError } from "@nanobpm/urban";
import type { AppJobHandler } from "@nanobpm/urban";
import { MAX_PLAN_REVIEW_ROUNDS, type PlanReview, planReviews } from "../../app/plan.ts";

interface In extends Record<string, unknown> {
  planKey: string;
  approved?: unknown;
  findings?: unknown;
}
interface Out extends Record<string, unknown> {
  planApproved: boolean;
  planFindings: string;
}

// Only an explicit boolean-true (or the string "true") approves; anything else — including a
// missing verdict — means revise. Bounded by the round cap, so this can't loop forever.
const isApproved = (v: unknown): boolean =>
  v === true || (typeof v === "string" && v.trim().toLowerCase() === "true");

export const str = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (v == null) return "";
  // JSON.stringify can throw (BigInt, circular refs) or return undefined (functions/symbols).
  // Never let a bad variable fail the whole job — fall back to String(v).
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const planKey = job.variables.planKey;
  const approved = isApproved(job.variables.approved);
  const findings = str(job.variables.findings).trim();
  const ts = new Date().toISOString();
  const jobKey = job.jobKey;

  const reviews = planReviews(app.data);

  // Idempotency guard: deriving the round from count(plan_reviews) is not retry-safe on its own.
  // A job retried after the insert (crash/timeout post-write) re-runs with the SAME jobKey — if
  // this job already recorded a row, reuse it rather than appending a duplicate, which would
  // inflate the count and reach the review-round cap early. Otherwise this is the first attempt:
  // derive the 0-based next round from the append-only log and record it under this jobKey.
  const recorded: PlanReview = (await reviews.findOne({ plan_key: planKey, job_key: jobKey })) ??
    await (async () => {
      const round = await reviews.count({ plan_key: planKey }); // 0-based: next round index
      const row: PlanReview = {
        plan_key: planKey,
        round,
        approved: approved ? 1 : 0,
        findings: findings || null,
        created_at: ts,
        job_key: jobKey,
      };
      await reviews.insert(row);
      return row;
    })();

  const round = recorded.round;
  const roundApproved = recorded.approved === 1;
  const roundFindings = recorded.findings ?? "";

  if (roundApproved) {
    return { planApproved: true, planFindings: roundFindings };
  }

  // Not approved this round. Hard-fail once the round cap is reached (issue #86): previously the
  // fan-out PROCEEDED regardless ("don't dead-lock on a reviewer that never approves"), which
  // dispatched an un-vetted plan and — when the plan was empty — completed the epic GREEN having
  // done nothing (instance 21). Instead raise a non-retryable BpmnError: no boundary catches
  // `PLAN_REJECTED`, so the engine parks the instance on an incident rather than dispatching an
  // un-approved plan. The round is 0-based, so `round + 1 >= cap` is the last permitted round.
  if (round + 1 >= MAX_PLAN_REVIEW_ROUNDS) {
    app.log("error", `record-plan-review: ${planKey} not approved after ${MAX_PLAN_REVIEW_ROUNDS} round(s)`, {
      round,
    });
    throw new BpmnError(
      "PLAN_REJECTED",
      `${planKey}: plan not approved after ${MAX_PLAN_REVIEW_ROUNDS} review round(s)`,
    );
  }

  // Otherwise loop: the planner revises against this round's findings.
  app.log("info", `record-plan-review: ${planKey} round ${round} — revise`, { approved: false });
  return { planApproved: false, planFindings: roundFindings };
};

export default handler;
