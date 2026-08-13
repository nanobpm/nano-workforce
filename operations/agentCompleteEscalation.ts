// POST /app/api/hooks/agent-complete → operationId `agentCompleteEscalation` (epic #156, slice U6;
// ADR 0046). Lets an AGENT assignee complete an escalation user task by submitting the SAME typed
// form variables a human would through the task inbox. The completion routes through the one
// canonical attributed completer (`completeEscalationAsAgent` → `completeUserTaskAttributed`), which
// records the agent's identity in the `task_completions` ledger (for attribution) and then resumes
// the process via `engine.completeUserTask` — the exact same resume path a human drives, no parallel
// lane. Optional shared-secret guard (x-hook-secret), enforced only when NANO_PR_WEBHOOK_SECRET is
// set, mirroring the other operator/webhook control surfaces.
//
// The runtime validates the body against openapi.yaml (`userTaskKey`, `agentId`, `variables` all
// required); this delegate narrows the validated shape and applies the shared-secret guard.

import { completeEscalationAsAgent } from "../app/agentCompletion.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const WEBHOOK_SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export default defineOperation("agentCompleteEscalation", async ({ req, body }, app) => {
  if (WEBHOOK_SECRET && req.headers.get("x-hook-secret") !== WEBHOOK_SECRET) {
    app.log.warn("agent-complete rejected: missing/invalid shared secret");
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }
  if (!body || typeof body !== "object") {
    app.log.warn("agent-complete rejected: missing request body");
    return { status: 400, body: { ok: false, error: "userTaskKey, agentId and variables are required" } };
  }

  const userTaskKey = str(body.userTaskKey);
  const agentId = str(body.agentId);
  const variables = body.variables;
  if (!userTaskKey) return { status: 400, body: { ok: false, error: "userTaskKey is required" } };
  if (!agentId) return { status: 400, body: { ok: false, error: "agentId is required" } };
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
    return { status: 400, body: { ok: false, error: "variables must be an object" } };
  }

  const r = await completeEscalationAsAgent(app.data, app.engine, {
    userTaskKey,
    agentId,
    variables,
  });
  if (r.ok) {
    app.log.info("agent completed escalation", { userTaskKey, agentId, elementId: r.elementId });
    return { status: 200, body: { ok: true, completionId: r.completionId, elementId: r.elementId } };
  }
  // A non-escalation / missing-target is a client error; an unknown key is a 404.
  const status = r.reason === "no open escalation task" ? 404 : 400;
  app.log.warn("agent-complete: not completed", { userTaskKey, reason: r.reason });
  return { status, body: { ok: false, error: r.reason } };
});
