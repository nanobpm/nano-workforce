// pr.persist-plan-escalation — the adversarial plan-review loop reached its per-epoch budget
// without approval. Record a plan-level human escalation and park the process until an operator
// answers with either `revise` (default: loop back to the planner with guidance and a fresh epoch)
// or `proceed` (explicit override: dispatch the current plan as-is).
import type { AppJobHandler } from "@nanobpm/urban";
import { planReviewEscalations, plans } from "../../app/plan.ts";

interface In extends Record<string, unknown> {
  planKey: string;
  planFindings?: unknown;
  planReviewEpoch?: unknown;
  planReviewRound?: unknown;
}
interface Out extends Record<string, unknown> {
  planEscalationId: number;
}

// Accept only genuine strings (trimmed); anything else is treated as missing so
// the explicit planKey guard fires instead of silently coercing (e.g. 123 -> "123")
// an escalation that BPMN correlation ("owner/repo#N") could never resume.
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const int = (v: unknown): number => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const planKey = str(job.variables.planKey);
  if (!planKey) {
    // No plan binding means we cannot correlate a resume — fail loudly rather
    // than silently parking a token that can never be answered.
    throw new Error("persist-plan-escalation: missing planKey in process scope");
  }
  const epoch = int(job.variables.planReviewEpoch);
  const round = int(job.variables.planReviewRound);
  const findings = str(job.variables.planFindings) || null;
  const ts = new Date().toISOString();

  const escTable = planReviewEscalations(app.data);
  const existing = (await escTable.find({ plan_key: planKey, status: "open" }))
    .sort((a, b) => b.id - a.id)[0];
  let escalationId: number;
  if (existing) {
    await escTable.update(existing.id, { epoch, round, findings });
    escalationId = existing.id;
  } else {
    escalationId = Number(
      await escTable.insert({
        plan_key: planKey,
        epoch,
        round,
        findings,
        status: "open",
        directive: null,
        note: null,
        asked_at: ts,
        answered_at: null,
      }),
    );
  }

  await plans(app.data).update(planKey, {
    status: "planning",
    open_plan_escalation_id: escalationId,
    open_plan_findings: findings,
    open_plan_round: round,
    updated_at: ts,
  });

  return { planEscalationId: escalationId };
};

export default handler;
