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
import { toEscalationView, userTasks } from "../app/userTasks.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("listEscalations", async ({ req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("listEscalations rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  const rows = await userTasks(app.data).all();
  const escalations = rows
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
    .map(toEscalationView);
  return { status: 200, body: { count: escalations.length, escalations } };
});
