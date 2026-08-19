// pr.record-feature-escalation — a feature run has parked on the native `feature-escalation`
// user task (the agent reported `status:"escalated"` with a non-blank `question`). This service
// task runs on the `escalated` arm, immediately BEFORE the user task is created, and:
//   • flips `feature_runs.status` to the non-terminal `escalated` so status-based views and counts
//     flag it (and a re-dispatch of the same issue short-circuits while it is parked), and
//   • appends the agent's `question` to the append-only `feature_escalations` audit log (issue #305),
//     the canonical, poller-readable source for a parked run's question.
//
// The completable `userTaskKey` is NOT recorded here — the task does not exist yet at this point.
// `pollUserTasks` (app/service.ts) reads the engine's open `feature-escalation` task directly once it
// is observable and projects it onto the `user_tasks` Tasks inbox, pairing it with the audit log's
// question. Capturing the question HERE (not in the poller) is required because the WASM testkit
// engine does not surface a user task's ioMapping-mapped local variables through the user-task query,
// so the process variable must be persisted while it is still in scope on the job.
import type { AppJobHandler } from "@nanobpm/urban";
import { featureRuns, recordFeatureEscalation } from "../../app/feature.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`RecordFeatureEscalationIn` in feature.bpmn) — ADR 0040.
type In = WorkerInputs["pr.record-feature-escalation"];

const nonBlank = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : null;

const handler: AppJobHandler<In> = async (job, app) => {
  const featureKey = job.variables.featureKey;
  const question = nonBlank(job.variables.question);
  await featureRuns(app.data).update(featureKey, {
    status: "escalated",
    updated_at: new Date().toISOString(),
  });
  // Append the question to the canonical `feature_escalations` audit log (issue #305) — the SURVIVING
  // table `pollUserTasks` reads to enrich the parked `feature-escalation` task's question on the Tasks
  // inbox (the feature analogue of `record-plan-review` writing `plan_reviews`). The denormalised
  // `feature_runs.escalation_question` column it used to dual-write was dropped in the contract phase
  // (issue #332), so this log is now the sole source of the question text.
  await recordFeatureEscalation(app.data, { featureKey, question, jobKey: job.jobKey });
  app.log.info("record-feature-escalation", { featureKey, hasQuestion: question !== null });
  return {};
};

export default handler;
