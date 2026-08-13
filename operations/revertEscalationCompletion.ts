// POST /app/api/hooks/revert-completion → operationId `revertEscalationCompletion` (epic #156, slice
// U6; ADR 0046 reversibility). A completed user task cannot be un-completed in the engine, so an
// AGENT answer is never a silent irreversible commit: this endpoint lets a human mark a reversible
// agent completion reverted/overridden, recording who did it and when. Host-side consumers read the
// `task_completions` ledger to see whether the latest completion is still authoritative. Human
// completions are not reversible (they are already the authority), and a completion can be reverted
// only once. Optional shared-secret guard (x-hook-secret), enforced only when NANO_PR_WEBHOOK_SECRET
// is set.

import { revertAgentCompletion } from "../app/agentCompletion.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const WEBHOOK_SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export default defineOperation("revertEscalationCompletion", async ({ req, body }, app) => {
  if (WEBHOOK_SECRET && req.headers.get("x-hook-secret") !== WEBHOOK_SECRET) {
    app.log.warn("revert-completion rejected: missing/invalid shared secret");
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }
  if (!body || typeof body !== "object") {
    app.log.warn("revert-completion rejected: missing request body");
    return { status: 400, body: { ok: false, error: "completionId and reverterId are required" } };
  }

  const completionId = typeof body.completionId === "number" ? body.completionId : Number.NaN;
  const reverterId = str(body.reverterId);
  const note = str(body.note);
  if (!Number.isInteger(completionId)) {
    return { status: 400, body: { ok: false, error: "completionId must be an integer" } };
  }
  if (!reverterId) return { status: 400, body: { ok: false, error: "reverterId is required" } };

  const r = await revertAgentCompletion(app.data, completionId, { kind: "human", id: reverterId }, note);
  if (r.ok) {
    app.log.info("agent completion reverted", { completionId, reverterId });
    return { status: 200, body: { ok: true, completionId: r.completionId } };
  }
  const status = r.reason === "no such completion" ? 404 : 400;
  app.log.warn("revert-completion: not reverted", { completionId, reason: r.reason });
  return { status, body: { ok: false, error: r.reason } };
});
