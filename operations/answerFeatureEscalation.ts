// POST /app/api/actions/answer-escalation → operationId `answerFeatureEscalation` (issue #210).
// The nwf UI's answer affordance for a native feature-run escalation: an operator answers the parked
// `feature-escalation` user task (resolution=answer/abandon + optional guidance) directly from the
// Feature / Overview pages, instead of only from the generic task inbox.
//
// It routes through the ONE canonical attributed completer (`completeEscalationAsHuman` →
// `completeUserTaskAttributed`), so the completion uses the exact same typed `.form` variables and
// engine resume path a human drives from the task inbox — no parallel completion — while recording
// WHO answered in the `task_completions` ledger. The poller then reconciles the run off `escalated`
// (pollFeatureEscalations) once the task is gone.
//
// The runtime validates the body against openapi.yaml (`userTaskKey` + `resolution` required); this
// delegate narrows the validated shape, enforces the answer/abandon contract, and builds the typed
// completion variables the `feature-escalation` form + the `w_gw_answer` gateway expect.

import { completeEscalationAsHuman } from "../app/agentCompletion.ts";
import { featureRuns } from "../app/feature.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export default defineOperation("answerFeatureEscalation", async ({ body }, app) => {
  if (!body || typeof body !== "object") {
    app.log.warn("answer-escalation rejected: missing request body");
    return { status: 400, body: { ok: false, error: "userTaskKey and resolution are required" } };
  }

  const userTaskKey = str(body.userTaskKey);
  if (!userTaskKey) return { status: 400, body: { ok: false, error: "userTaskKey is required" } };

  const resolution = str(body.resolution);
  if (resolution !== "answer" && resolution !== "abandon") {
    return { status: 400, body: { ok: false, error: "resolution must be 'answer' or 'abandon'" } };
  }

  // The `feature-escalation` form completes with `{ resolution, answer }`; the `w_gw_answer` gateway
  // re-dispatches implement-task with `answer` when resolution=answer, else routes to record-feature.
  // Guidance is required for an answer (an empty answer re-dispatches the agent with nothing new).
  const answer = str(body.answer);
  if (resolution === "answer" && !answer) {
    return { status: 400, body: { ok: false, error: "answer (guidance) is required when resolution is 'answer'" } };
  }
  const variables: Record<string, unknown> = resolution === "answer" ? { resolution, answer } : { resolution };

  // The completing operator, for the attribution ledger. Optional — the UI has no per-operator auth,
  // so default to a generic handle rather than blocking the answer.
  const operatorId = str(body.operator) || "operator";

  const r = await completeEscalationAsHuman(app.data, app.engine, { userTaskKey, operatorId, variables });
  if (r.ok) {
    // Reconcile this operation's OWN action immediately: clear the denormalised escalation pointer +
    // question so the pages stop offering an answer affordance for a task that is now completed. Leave
    // `status` to the poller (escalated → running on the answer loop) / record-feature (terminal on
    // abandon), so we never overwrite a status the resumed run has already advanced to.
    for (const run of await featureRuns(app.data).find({ escalation_user_task_key: userTaskKey })) {
      await featureRuns(app.data).update(run.feature_key, {
        escalation_question: null,
        escalation_user_task_key: null,
        updated_at: new Date().toISOString(),
      });
    }
    app.log.info("operator answered feature escalation", { userTaskKey, resolution, elementId: r.elementId });
    return { status: 200, body: { ok: true, completionId: r.completionId, elementId: r.elementId } };
  }
  const status = r.reason === "no open escalation task" ? 404 : 400;
  app.log.warn("answer-escalation: not completed", { userTaskKey, reason: r.reason });
  return { status, body: { ok: false, error: r.reason } };
});
