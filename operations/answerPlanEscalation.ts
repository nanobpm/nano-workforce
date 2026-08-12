// POST /app/api/hooks/plan-answer → operationId `answerPlanEscalation`. Answers a plan-review
// cap escalation out of band. The process is parked on `plan-escalation-answered`, correlated by
// planKey; the answer records the human directive and resumes the plan.
import { answerPlanEscalation as answerPlanEscalationState } from "../app/plan.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const WEBHOOK_SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export default defineOperation("answerPlanEscalation", async ({ req, body }, app) => {
  if (WEBHOOK_SECRET && req.headers.get("x-hook-secret") !== WEBHOOK_SECRET) {
    app.log.warn("plan-answer rejected: missing/invalid shared secret");
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }
  if (!body || typeof body !== "object") {
    app.log.warn("plan-answer rejected: missing request body");
    return { status: 400, body: { ok: false, error: "plan and directive are required" } };
  }

  const planKey = str(body.plan);
  const directive = str(body.directive).toLowerCase();
  const note = str(body.note);
  if (!planKey) {
    app.log.warn("plan-answer rejected: missing plan");
    return { status: 400, body: { ok: false, error: "plan is required" } };
  }
  if (directive !== "proceed" && directive !== "revise") {
    app.log.warn("plan-answer rejected: invalid directive", { directive });
    return { status: 400, body: { ok: false, error: "directive must be proceed or revise" } };
  }

  const r = await answerPlanEscalationState(app.data, app.engine, planKey, directive, note);
  if (r.ok) app.log.info("plan escalation answered", { planKey, directive });
  else app.log.warn("plan-answer: no open plan escalation to answer", { planKey });
  return { status: r.ok ? 200 : 404, body: r };
});
