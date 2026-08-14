// POST /app/api/actions/acknowledge-blocked → operationId `acknowledgeBlocked` (issue #220).
// The nwf UI's completion affordance for a BLOCKED single-issue feature run: an operator acknowledges
// the parked `feature-blocked` user task (with an optional disposition note) directly from the Feature /
// Overview pages, instead of the run sitting parked forever with no control (the escalation path got
// this in issue #210; the blocked path did not).
//
// It routes through the ONE canonical attributed completer (`completeBlockedAsHuman` →
// `completeUserTaskAttributed`), so the completion uses the exact same typed `.form` variable (`note`)
// and engine resume path a human drives from the task inbox — no parallel completion — while recording
// WHO acknowledged in the `task_completions` ledger. Completing the task fires `pr.record-blocked-ack`,
// which settles the row to the terminal `blocked` status with the operator's note. The poller then
// reconciles the completable-task pointer off the row (pollFeatureBlocked) once the task is gone.
//
// The runtime validates the body against openapi.yaml (`userTaskKey` required); this delegate narrows
// the validated shape and builds the typed completion variables the `feature-blocked` form + the
// `record-blocked-ack` ioMapping expect.

import { completeBlockedAsHuman } from "../app/agentCompletion.ts";
import { featureRuns } from "../app/feature.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export default defineOperation("acknowledgeBlocked", async ({ body }, app) => {
  if (!body || typeof body !== "object") {
    app.log.warn("acknowledge-blocked rejected: missing request body");
    return { status: 400, body: { ok: false, error: "userTaskKey is required" } };
  }

  const userTaskKey = str(body.userTaskKey);
  if (!userTaskKey) return { status: 400, body: { ok: false, error: "userTaskKey is required" } };

  // The `feature-blocked` form completes with an optional `note`; the `record-blocked-ack` ioMapping
  // reads it (`if is defined(note) then note else null`) into `delivery_label`. An absent/blank note is
  // recorded as an "acknowledged" label rather than an empty string — omit the variable entirely so the
  // ioMapping's `is defined` fallback fires.
  const note = str(body.note);
  const variables: Record<string, unknown> = note ? { note } : {};

  // The completing operator, for the attribution ledger. Optional — the UI has no per-operator auth, so
  // default to a generic handle rather than blocking the acknowledgement.
  const operatorId = str(body.operator) || "operator";

  const r = await completeBlockedAsHuman(app.data, app.engine, { userTaskKey, operatorId, variables });
  if (r.ok) {
    // Reconcile this operation's OWN action immediately: clear the denormalised blocked pointer so the
    // pages stop offering an acknowledge affordance for a task that is now completed. Leave `status` to
    // `record-blocked-ack` (which settles it to terminal `blocked`), so we never overwrite the status the
    // resumed run has advanced to.
    for (const run of await featureRuns(app.data).find({ blocked_user_task_key: userTaskKey })) {
      await featureRuns(app.data).update(run.feature_key, {
        blocked_user_task_key: null,
        updated_at: new Date().toISOString(),
      });
    }
    app.log.info("operator acknowledged blocked feature run", { userTaskKey, elementId: r.elementId });
    return { status: 200, body: { ok: true, completionId: r.completionId, elementId: r.elementId } };
  }
  const status = r.reason === "no open blocked task" ? 404 : 400;
  app.log.warn("acknowledge-blocked: not completed", { userTaskKey, reason: r.reason });
  return { status, body: { ok: false, error: r.reason } };
});
