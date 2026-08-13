// pr.record-plan-review — record one adversarial plan-review round and decide whether the
// fan-out proceeds or the planner revises (issue: gate the plan before dispatch).
//
// The `senior:plan-review` agent critiqued the levelized plan and emitted `{ approved, findings }`.
// This worker:
//   • reads the current epoch from the durable `planReviewEpoch` process variable (bumped by the
//     `plan-review-decision` user task each time a human answers a plan-review escalation) and
//     derives the current round from the append-only `plan_reviews` log for that epoch (no counter
//     variable), using the engine jobKey as an idempotency guard so a retried job reuses its row,
//   • records this round's verdict + findings,
//   • decides the loop: emits `planApproved` (reviewer said yes → the BPMN gateway proceeds to
//     `select-wave`) or, when unapproved, re-emits the findings as `planFindings` so a revise
//     round feeds the planner and loops back to `plan`.
//
// When the review-round cap is reached WITHOUT approval, this worker emits `planEscalated` so the
// BPMN parks on a human plan-review escalation rather than proceeding regardless or raising an
// unhandled incident. Proceeding used to dispatch an un-vetted plan and — when the plan was empty —
// let the whole epic complete GREEN having done nothing. A missing/ambiguous `approved` is treated
// as NOT approved (revise until the cap, then escalate).

import type { AppJobHandler } from "@nanobpm/urban";
import {
  MAX_PLAN_REVIEW_ROUNDS,
  type PlanReview,
  planReviews,
} from "../../app/plan.ts";

interface In extends Record<string, unknown> {
  planKey: string;
  approved?: unknown;
  findings?: unknown;
  planReviewEpoch?: unknown;
}
interface Out extends Record<string, unknown> {
  planApproved: boolean;
  planEscalated: boolean;
  planFindings: string;
  planReviewEpoch: number;
  planReviewRound: number;
}

// Only an explicit boolean-true (or the string "true") approves; anything else — including a
// missing verdict — means revise. Bounded by the round cap, so this can't loop forever.
const isApproved = (v: unknown): boolean =>
  v === true || (typeof v === "string" && v.trim().toLowerCase() === "true");

// The plan-review epoch is a durable process variable. It is null/absent on the first review round
// (before any human answer) and a non-negative integer once the `plan-review-decision` user task
// has bumped it. Coerce anything unexpected to 0 so a round is always recorded under a valid epoch.
const coerceEpoch = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  return Number.isInteger(n) && n >= 0 ? n : 0;
};

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
  const epoch = coerceEpoch(job.variables.planReviewEpoch);

  // Idempotency guard: deriving the epoch/round from count(plan_reviews) is not retry-safe on its
  // own. A job retried after the insert (crash/timeout post-write) re-runs with the SAME jobKey —
  // if this job already recorded a row, reuse it rather than appending a duplicate, which would
  // inflate the count and reach the review-round cap early. Otherwise this is the first attempt:
  // derive the 0-based next round from the append-only log for the current epoch and record it
  // under this jobKey.
  const recorded: PlanReview = (await reviews.findOne({ plan_key: planKey, job_key: jobKey })) ??
    await (async () => {
      const round = await reviews.count({ plan_key: planKey, epoch }); // 0-based: next round index
      const row: PlanReview = {
        plan_key: planKey,
        epoch,
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
  const recordedEpoch = recorded.epoch;
  const roundApproved = recorded.approved === 1;
  const roundFindings = recorded.findings ?? "";

  if (roundApproved) {
    return {
      planApproved: true,
      planEscalated: false,
      planFindings: roundFindings,
      planReviewEpoch: recordedEpoch,
      planReviewRound: round,
    };
  }

  // Not approved this round. Escalate once the per-epoch round cap is reached (issue #86):
  // previously the fan-out PROCEEDED regardless, dispatching an un-vetted plan. The round is
  // 0-based, so `round + 1 >= cap` is the last permitted round.
  if (round + 1 >= MAX_PLAN_REVIEW_ROUNDS) {
    app.log.warn(`record-plan-review: ${planKey} not approved after ${MAX_PLAN_REVIEW_ROUNDS} round(s)`, {
      epoch: recordedEpoch,
      round,
    });
    return {
      planApproved: false,
      planEscalated: true,
      planFindings: roundFindings,
      planReviewEpoch: recordedEpoch,
      planReviewRound: round,
    };
  }

  // Otherwise loop: the planner revises against this round's findings.
  app.log.info(`record-plan-review: ${planKey} epoch ${recordedEpoch} round ${round} — revise`, { approved: false });
  return {
    planApproved: false,
    planEscalated: false,
    planFindings: roundFindings,
    planReviewEpoch: recordedEpoch,
    planReviewRound: round,
  };
};

export default handler;
