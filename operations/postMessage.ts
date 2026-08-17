// POST /app/api/actions/message → operationId `postMessage` (ADR 0058, base /app/api).
// Replaces the hand-rolled action that overrode the generic publishMessage action: publish an
// arbitrary BPMN message (optionally correlated) into the engine.
//
// Every escalation kind is now a native `userTask` answered through the ONE canonical human/agent
// completer (`completeUserTask` → `completeUserTaskAttributed`) and surfaced in the Tasks inbox —
// including the merge-loop escalation, which converged from a durable `escalation-answered` message
// catch onto a native user task (#256). So this delegate no longer carries any bespoke
// escalation-answer discriminator; it is a thin, generic message publish. The runtime validates the
// body against openapi.yaml (`name` is required, so a missing name is a 400 for free).

import { defineOperation } from "../nano-generated/operations.ts";

export default defineOperation("postMessage", async ({ body }, app) => {
  const b = body ?? {};
  const name = String(b.name ?? "");
  if (!name) {
    app.log.warn("postMessage rejected: missing name");
    return { status: 400, body: { error: "name is required" } };
  }

  await app.engine.publishMessage({
    name,
    correlationKey: b.correlationKey != null ? String(b.correlationKey) : undefined,
    variables: b.variables,
  });
  app.log.info("message published", { name });
  return { status: 200, body: { ok: true } };
});
