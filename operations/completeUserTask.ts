// POST /app/api/actions/complete-user-task → operationId `completeUserTask` (issue #236).
//
// The nwf **Tasks** page's decision affordance for the native user-task escalations that had no
// app-side completion path — `plan-review-decision`, `trial-merge-decision`, the PR review-loop
// `wait-answer`, the feature escalation `feature-escalation`, and the human-only `feature-blocked`
// acknowledgement. An operator submits the parked task's typed `.form` variables (e.g. a plan-review
// `{ directive, notes }`, a trial-merge `{ action, notes }`, a PR `{ answer }`, a feature escalation
// `{ resolution, answer }`, or a blocked-run `{ note }`) directly from the Tasks inbox instead of only
// from Urban's read-only task-inbox stub.
//
// It routes through the ONE canonical human completer (`completeEscalationAsHuman` →
// `completeUserTaskAttributed`), so the completion uses the exact same typed variables and engine
// resume path a human drives from the task inbox — no parallel completion — while recording WHO
// answered in the `task_completions` ledger. That completer refuses any user task that is not one of
// the human-completable elements (`HUMAN_COMPLETABLE_ELEMENTS`), so this generic door can never
// complete an arbitrary internal user task. Issue #332 retired the bespoke feature-run reconcile doors
// (`answer-escalation` / `acknowledge-blocked`) and folded `feature-escalation` / `feature-blocked`
// onto this one canonical door.
//
// On success it removes the answered task's `user_tasks` read-model row so the Tasks grid stops
// offering a decision for a task that is now completed, without waiting a poll cycle; the poller
// (`pollUserTasks`) is the durable source of truth and will re-derive the exact same empty state.
// That read-model cleanup is best-effort — a transient delete failure is logged and swallowed rather
// than masking a completion the engine has already resumed with a spurious 5xx.
//
// The runtime validates the body against openapi.yaml (`userTaskKey` + `variables` required); this
// delegate narrows the validated shape and applies the shared human-completion contract.

import { completeEscalationAsHuman } from "../app/agentCompletion.ts";
import { userTasks } from "../app/userTasks.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export default defineOperation("completeUserTask", async ({ body }, app) => {
  if (!body || typeof body !== "object") {
    app.log.warn("complete-user-task rejected: missing request body");
    return { status: 400, body: { ok: false, error: "userTaskKey and variables are required" } };
  }

  const userTaskKey = str(body.userTaskKey);
  if (!userTaskKey) return { status: 400, body: { ok: false, error: "userTaskKey is required" } };

  const variables = body.variables;
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
    return { status: 400, body: { ok: false, error: "variables must be an object" } };
  }

  // The completing operator, for the attribution ledger. Optional — the UI has no per-operator auth,
  // so default to a generic handle rather than blocking the completion.
  const operatorId = str(body.operator) || "operator";

  const r = await completeEscalationAsHuman(app.data, app.engine, { userTaskKey, operatorId, variables });
  if (r.ok) {
    // Reconcile this operation's OWN action immediately: drop the read-model row so the Tasks page
    // stops offering a decision for a task that is now completed. The poller re-derives the same
    // state, so this is a latency optimisation, not the source of truth — make it best-effort so a
    // transient cleanup failure never masks a completion the engine has already resumed (which would
    // return a spurious 5xx to the UI for a task that IS done). The poller re-derives the empty state.
    try {
      await userTasks(app.data).delete(userTaskKey);
    } catch (err) {
      app.log.warn("complete-user-task: read-model cleanup failed (poller will reconcile)", {
        userTaskKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    app.log.info("operator completed user task", { userTaskKey, elementId: r.elementId });
    return { status: 200, body: { ok: true, completionId: r.completionId, elementId: r.elementId } };
  }
  const status = r.reason === "no open escalation task" ? 404 : 400;
  app.log.warn("complete-user-task: not completed", { userTaskKey, reason: r.reason });
  return { status, body: { ok: false, error: r.reason } };
});
