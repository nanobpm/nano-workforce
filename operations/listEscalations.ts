// GET /app/api/escalations → operationId `listEscalations` (epic #664, issue #666). Discovery for the
// escalation-answer path: list EVERY currently-open native user-task escalation — across every
// surfaced kind (PR review/merge loop, plan-review, empty-plan, trial-merge, conformance-review,
// delivery human-step, feature/blocked, agent-permission and the shared human-escalation cell) —
// with the completable `userTaskKey` an agent then answers via
// `completeUserTask` / `agentCompleteEscalation`. This closes the fallback where an agent had to curl
// the un-projected `/tasks/api/tasks` inbox to find keys before answering.
//
// Read-only projection over the ONE `user_tasks` read model the Tasks inbox and Convergence page
// consume (`userTasks` + the pure `toEscalationView` derivation in app/userTasks.ts) — NOT a second
// source of truth. A row exists iff its task is open, so the list reflects live pending work.
//
// The optional shared-secret guard stays HERE (the runtime does not enforce OpenAPI `security`):
// when NANO_PR_WEBHOOK_SECRET is set, callers must present it via the x-hook-secret header. Unset →
// open (unchanged default), mirroring `listActivePrs`.
import { escalationExpectedFields } from "../app/agentCompletion.ts";
import { listEnvelope, withProcessInstanceKey } from "../app/apiShape.ts";
import { applyEscalationFilter, parseEscalationFilter } from "../app/listFilters.ts";
import { toEscalationView, userTasks } from "../app/userTasks.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("listEscalations", async ({ req, query }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("listEscalations rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  // Issue #1060: server-side filters (kind/repo/key), AND-combined; page.totalItems is the filtered count.
  const parsed = parseEscalationFilter({ ...query });
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  const rows = await userTasks(app.data).all();
  const escalations = rows
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
    .map((row) => ({
      ...withProcessInstanceKey(toEscalationView(row)),
      // Issue #989: the answer fields this escalation's `.form` expects (the SAME contract the
      // completer enforces), so a caller can build `escalations answer` variables from the listing.
      expectedFields: escalationExpectedFields(row.element_id, row.form_key),
    }));
  return { status: 200, body: listEnvelope(applyEscalationFilter(escalations, parsed.filter)) };
});
