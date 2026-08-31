// pr.record-feature-implementing — the twin of `record-feature-escalation` (issue #642). This
// service task sits on BOTH edges into `implement-task`: the first entry (`f_toImplement`, off
// `ensure-base-branch` in `feature.bpmn`) AND the answer re-entry — which, after the ADR 0006 S4
// composition, lives on the shared `implement-cell`'s answer loop (`ic_answerLoop` → `record-implementing`
// → `implement-task`), keyed by `subjectKey`. It stamps `feature_runs.status="running"` so the run is
// `escalated` ONLY while a token is parked on the native escalation user task — honouring the invariant
// `record-feature-escalation` (the sole `escalated` writer) would otherwise violate on the answer
// loop-back: it had no symmetric reset, so `status` stayed a stale `escalated` through the ENTIRE
// post-answer re-implementation (the #632 tear). Parity with the PR `status="escalated"` contract,
// which holds only while parked.
//
// Keyed by `subjectKey` (the composed cell) or `featureKey` (feature.bpmn's first entry). A
// plan-embedded wave slice (`subjectKey` = the epic's `plan_key`) has no `feature_runs` row, so the
// reset is a guarded no-op there — symmetric with `record-feature-escalation`'s guarded flip, never
// fabricating a bogus row.
//
// Idempotent-safe: re-stamping `running` is a no-op FOR THE STATUS, so the at-least-once job can retry
// freely; it does still refresh `updated_at` on every invocation (a confirming timestamp write), and
// stamping `running` on the very first entry (when the row is already `running` from dispatch) is a
// harmless confirming write.
import type { AppJobHandler } from "@nanobpm/urban";
import { featureRuns } from "../../app/feature.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`RecordFeatureImplementingIn` in feature.bpmn) — ADR 0040.
type In = WorkerInputs["pr.record-feature-implementing"];

const handler: AppJobHandler<In> = async (job, app) => {
  // Keyed by `subjectKey` when composed inside the shared `implement-cell` answer loop (ADR 0006 S4),
  // or by `featureKey` on `feature.bpmn`'s first-entry edge. A plan-embedded wave slice
  // (`subjectKey` = the epic's `plan_key`) has no `feature_runs` row, so the reset is a guarded no-op
  // there — symmetric with `record-feature-escalation`'s guarded flip — never fabricating a bogus row.
  const subjectKey = job.variables.subjectKey ?? job.variables.featureKey;
  if (!subjectKey) return {};
  const runs = featureRuns(app.data);
  if (await runs.get(subjectKey)) {
    await runs.update(subjectKey, {
      status: "running",
      updated_at: new Date().toISOString(),
    });
  }
  app.log.info("record-feature-implementing", { subjectKey });
  return {};
};

export default handler;
