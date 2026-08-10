// POST /app/api/actions/message → operationId `postMessage` (ADR 0058, base /app/api).
// Replaces the hand-rolled action that overrode the generic publishMessage action. For the
// `escalation-answered` message we run the review answer flow, and for `feature-escalation-answered`
// (issue #25) the implementation-phase (per-task) answer flow: record the answer, resume the parked
// token, then re-surface the next open escalation. Any other message falls back to a plain
// publishMessage.
//
// The runtime validates the body against openapi.yaml (`name` is required, so a missing name is a 400
// for free); this delegate keeps the message-name dispatch — the discriminator + downstream behavior
// is app logic, not something the JSON schema can express.
import { defineOperation } from "@nanobpm/urban";
import { answerTaskEscalation, FEATURE_ESCALATION_MESSAGE } from "../app/plan.ts";
import { answerEscalation } from "../app/service.ts";

interface Body {
  name?: unknown;
  correlationKey?: unknown;
  variables?: Record<string, unknown>;
}

export default defineOperation<
  { params: Record<string, string>; query: Record<string, string | string[] | undefined>; body: Body },
  Record<string, unknown>
>("postMessage", async ({ body }, app) => {
  const b = body ?? {};
  const name = String(b.name ?? "");
  if (!name) return { status: 400, body: { error: "name is required" } };

  if (name === "escalation-answered") {
    const prKey = String(b.correlationKey ?? "");
    const answer = String(b.variables?.answer ?? "").trim();
    if (!prKey) return { status: 400, body: { error: "correlationKey is required" } };
    if (!answer) return { status: 400, body: { error: "answer is required" } };
    const r = await answerEscalation(app.data, app.engine, prKey, answer);
    return { status: r.ok ? 200 : 404, body: r };
  }

  if (name === FEATURE_ESCALATION_MESSAGE) {
    // Implementation-phase task escalation (issue #25): correlationKey is the task's
    // `<plan_key>:<task_id>`; record the answer, resume the parked child, and re-surface the next
    // open escalation.
    const corrKey = String(b.correlationKey ?? "");
    const answer = String(b.variables?.answer ?? "").trim();
    if (!corrKey) return { status: 400, body: { error: "correlationKey is required" } };
    if (!answer) return { status: 400, body: { error: "answer is required" } };
    const r = await answerTaskEscalation(app.data, app.engine, corrKey, answer);
    return { status: r.ok ? 200 : 404, body: r };
  }

  await app.engine.publishMessage({
    name,
    correlationKey: b.correlationKey != null ? String(b.correlationKey) : undefined,
    variables: b.variables,
  });
  return { status: 200, body: { ok: true } };
});
