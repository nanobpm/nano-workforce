// POST /app/api/hooks/feature-answer → operationId `answerFeatureEscalation` (ADR 0059 webhook
// operation; was the `/hooks/feature-answer` action). Answers an implementation-phase task
// escalation out of band (optional shared-secret guard via X-Hook-Secret, enforced only when
// NANO_PR_WEBHOOK_SECRET is set — mirrors the operator control surface), issue #25. Lets an
// external system (a chat relay, a CI job, a human via curl) resume a parked implementation agent
// without the page. Same idempotent `answerTaskEscalation` path the page's answer form uses.
//
// The runtime validates the body shape against openapi.yaml — a `oneOf` of EXACTLY ONE addressing
// form (`{ corrKey, answer }` OR `{ plan, task, answer }`), so a body that supplies neither form (or
// mixes them) is rejected at the edge with a 400 that names the allowed shapes. This delegate narrows
// the validated variant and keeps the semantic normalization the schema can't express (an answer /
// correlation key that is present but blank-after-trim) plus the shared-secret guard.
//   { "corrKey": "owner/repo#12:task-3", "answer": "…" }
//   { "plan": "owner/repo#12", "task": "task-3", "answer": "…" }

import { answerTaskEscalation, featureCorrKey } from "../app/plan.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const WEBHOOK_SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export default defineOperation("answerFeatureEscalation", async ({ req, body }, app) => {
  if (WEBHOOK_SECRET && req.headers.get("x-hook-secret") !== WEBHOOK_SECRET) {
    app.log.warn("feature-answer rejected: missing/invalid shared secret");
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }
  const answer = str(body.answer);
  if (!answer) {
    app.log.warn("feature-answer rejected: blank answer");
    return { status: 400, body: { ok: false, error: "answer is required" } };
  }

  const corrKey = "corrKey" in body
    ? str(body.corrKey)
    : str(body.plan) && str(body.task)
      ? featureCorrKey(str(body.plan), str(body.task))
      : "";
  if (!corrKey) {
    app.log.warn("feature-answer rejected: unresolvable correlation key");
    return {
      status: 400,
      body: { ok: false, error: "provide corrKey, or both plan (owner/repo#N) and task" },
    };
  }

  const r = await answerTaskEscalation(app.data, app.engine, corrKey, answer);
  if (r.ok) app.log.info("feature escalation answered", { corrKey });
  else app.log.warn("feature-answer: no open escalation to answer", { corrKey });
  return { status: r.ok ? 200 : 404, body: r };
});
