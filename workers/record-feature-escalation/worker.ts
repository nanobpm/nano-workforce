// pr.record-feature-escalation — a feature run has parked on the native `feature-escalation`
// user task (the agent reported `status:"escalated"` with a non-blank `question`). This service
// task runs on the `escalated` arm, immediately BEFORE the user task is created, and persists the
// escalation onto the `feature_runs` row so the nwf UI can surface it (issue #210):
//   • flips `status` to the non-terminal `escalated` so status-based views and counts flag it, and
//   • denormalises the agent's `question` for the Escalation column + the answer affordance.
//
// It deliberately does NOT record a REAL completable `userTaskKey` — the task does not exist yet at
// this point — and clears any stale pointer so the row reads "key unknown until observed".
// `pollFeatureEscalations` (app/service.ts) fills that pointer in once the user task is
// observable via `searchUserTasks`, which is also the reason the question is captured HERE rather
// than by the poller: the WASM testkit engine does not surface a user task's ioMapping-mapped local
// variables through `searchUserTasks`, so the process variable must be persisted while it is still
// in scope on the job.
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
    escalation_question: question,
    // The user task does not exist yet, so any non-null pointer here can only be stale (a prior
    // escalation's key, a manual DB repair). Clear it so the row reads "key unknown until observed"
    // and the pages don't bind the answer/abandon affordance to a dead task; the poller re-fills the
    // real key (it can always re-derive it from `searchUserTasks`), so this clear is never lossy.
    escalation_user_task_key: null,
    updated_at: new Date().toISOString(),
  });
  // Append the question to the canonical `feature_escalations` audit log (issue #305) so the poller
  // can source it from a SURVIVING table once the denormalised `feature_runs.escalation_question`
  // column is dropped in the contract phase — the feature analogue of `record-plan-review` writing
  // `plan_reviews`. Dual-write for now (the column above still feeds the legacy page reads); the log
  // is authoritative for `pollUserTasks`.
  await recordFeatureEscalation(app.data, { featureKey, question, jobKey: job.jobKey });
  app.log.info("record-feature-escalation", { featureKey, hasQuestion: question !== null });
  return {};
};

export default handler;
