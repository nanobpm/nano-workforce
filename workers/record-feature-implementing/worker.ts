// pr.record-feature-implementing — the twin of `record-feature-escalation` (issue #642). This
// service task sits on BOTH edges into `implement-task`: the first entry (`f_toImplement`, off
// `ensure-base-branch`) AND the answer re-entry (`w_answerLoop`, off the `w_gw_answer` gateway).
// It stamps `feature_runs.status="running"` so the run is `escalated` ONLY while a token is parked
// on the native `feature-escalation` user task — honouring the invariant `record-feature-escalation`
// (the sole `escalated` writer) would otherwise violate on the answer loop-back: it had no symmetric
// reset, so `status` stayed a stale `escalated` through the ENTIRE post-answer re-implementation
// (the #632 tear). Parity with the PR `status="escalated"` contract, which holds only while parked.
//
// Idempotent-safe: re-stamping `running` is a no-op, so the at-least-once job can retry freely, and
// stamping `running` on the very first entry (when the row is already `running` from dispatch) is a
// harmless confirming write.
import type { AppJobHandler } from "@nanobpm/urban";
import { featureRuns } from "../../app/feature.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`RecordFeatureImplementingIn` in feature.bpmn) — ADR 0040.
type In = WorkerInputs["pr.record-feature-implementing"];

const handler: AppJobHandler<In> = async (job, app) => {
  const featureKey = job.variables.featureKey;
  await featureRuns(app.data).update(featureKey, {
    status: "running",
    updated_at: new Date().toISOString(),
  });
  app.log.info("record-feature-implementing", { featureKey });
  return {};
};

export default handler;
