// pr.record-feature-escalation — a feature run has parked on the native `feature-escalation`
// user task (the agent reported `status:"escalated"` with a non-blank `question`). This service
// task runs on the `escalated` arm, immediately BEFORE the user task is created, and persists the
// escalation onto the `feature_runs` row so the nwf UI can surface it (issue #210):
//   • flips `status` to the non-terminal `escalated` so status-based views and counts flag it, and
//   • denormalises the agent's `question` for the Escalation column + the answer affordance.
//
// It deliberately does NOT record the completable `userTaskKey` — the task does not exist yet at
// this point. `pollFeatureEscalations` (app/service.ts) fills that pointer in once the user task is
// observable via `searchUserTasks`, which is also the reason the question is captured HERE rather
// than by the poller: the WASM testkit engine does not surface a user task's ioMapping-mapped local
// variables through `searchUserTasks`, so the process variable must be persisted while it is still
// in scope on the job.
import type { AppJobHandler } from "@nanobpm/urban";
import { featureRuns } from "../../app/feature.ts";
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
    updated_at: new Date().toISOString(),
  });
  app.log.info("record-feature-escalation", { featureKey, hasQuestion: question !== null });
  return {};
};

export default handler;
