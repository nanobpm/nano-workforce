// POST /app/api/hooks/feature-answer → operationId `answerFeatureEscalation` (ADR 0059 webhook
// operation; was the `/hooks/feature-answer` action). Answers an implementation-phase task
// escalation out of band (optional shared-secret guard via X-Hook-Secret, enforced only when
// NANO_PR_WEBHOOK_SECRET is set — mirrors the operator control surface), issue #25. Lets an
// external system (a chat relay, a CI job, a human via curl) resume a parked implementation agent
// without the page. Same idempotent `answerTaskEscalation` path the page's answer form uses.
//
// The runtime validates the body shape against openapi.yaml; this delegate keeps the semantic
// checks (an answer is required; a correlation key must be resolvable) and the shared-secret guard.
// Body accepts either the raw correlation key or a plan+task pair:
//   { "corrKey": "owner/repo#12:task-3", "answer": "…" }
//   { "plan": "owner/repo#12", "task": "task-3", "answer": "…" }
import { defineOperation } from "@nanobpm/urban";
import { answerTaskEscalation, featureCorrKey } from "../app/plan.ts";

const WEBHOOK_SECRET = process.env.NANO_PR_WEBHOOK_SECRET ?? "";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

interface Body {
  corrKey?: unknown;
  plan?: unknown;
  task?: unknown;
  answer?: unknown;
}

export default defineOperation<
  { params: Record<string, string>; query: Record<string, string | string[] | undefined>; body: Body },
  { ok: boolean } & Record<string, unknown>
>("answerFeatureEscalation", async ({ req, body }, app) => {
  if (WEBHOOK_SECRET && req.headers.get("x-hook-secret") !== WEBHOOK_SECRET) {
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }
  const b = body ?? {};
  const answer = str(b.answer);
  if (!answer) return { status: 400, body: { ok: false, error: "answer is required" } };

  const corrKey = str(b.corrKey) || (str(b.plan) && str(b.task) ? featureCorrKey(str(b.plan), str(b.task)) : "");
  if (!corrKey) {
    return {
      status: 400,
      body: { ok: false, error: "provide corrKey, or both plan (owner/repo#N) and task" },
    };
  }

  const r = await answerTaskEscalation(app.data, app.engine, corrKey, answer);
  return { status: r.ok ? 200 : 404, body: r };
});
