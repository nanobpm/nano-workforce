// POST /app/api/actions/message → operationId `postMessage` (ADR 0058, base /app/api).
// Replaces the hand-rolled action that overrode the generic publishMessage action. For the
// merge-loop `escalation-answered` message we run the merge-loop escalation answer flow; any other
// message falls back to a plain publishMessage.
//
// The four #156 escalation kinds (task, plan-review, trial-merge, PR review-loop) are now native
// `userTask`s answered directly through the task inbox (`POST /tasks/api/complete`), so this
// delegate no longer carries their bespoke `feature-escalation-answered` / `plan-escalation-answered`
// discriminators. The merge-loop escalation is still a durable message catch (out of scope for
// #156), so its `escalation-answered` branch is kept.
//
// The runtime validates the body against openapi.yaml (`name` is required, so a missing name is a 400
// for free); this delegate keeps the message-name dispatch — the discriminator + downstream behavior
// is app logic, not something the JSON schema can express.

import { answerEscalation } from "../app/service.ts";
import { defineOperation } from "../nano-generated/operations.ts";

export default defineOperation("postMessage", async ({ body }, app) => {
  const b = body ?? {};
  const name = String(b.name ?? "");
  if (!name) {
    app.log.warn("postMessage rejected: missing name");
    return { status: 400, body: { error: "name is required" } };
  }

  if (name === "escalation-answered") {
    const prKey = String(b.correlationKey ?? "");
    const answer = String(b.variables?.answer ?? "").trim();
    if (!prKey) return { status: 400, body: { error: "correlationKey is required" } };
    if (!answer) return { status: 400, body: { error: "answer is required" } };
    const r = await answerEscalation(app.data, app.engine, prKey, answer);
    if (r.ok) app.log.info("merge-loop escalation answered", { name, prKey });
    else app.log.warn("postMessage: no open merge-loop escalation to answer", { name, prKey });
    return { status: r.ok ? 200 : 404, body: r };
  }

  await app.engine.publishMessage({
    name,
    correlationKey: b.correlationKey != null ? String(b.correlationKey) : undefined,
    variables: b.variables,
  });
  app.log.info("message published", { name });
  return { status: 200, body: { ok: true } };
});
