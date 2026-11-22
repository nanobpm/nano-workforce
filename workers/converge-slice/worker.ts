// pr.converge-slice — the `converge-cell`'s plan-slice arm (issue #1007): enroll an epic slice's
// opened PR into the review-convergence loop from inside the epic. The decision lives in the
// canonical, unit-tested `app/sliceConverge.ts`; this handler is the thin engine seam over `submitPr`.
import type { AppJobHandler } from "@nanobpm/urban";
import { MAX_ROUNDS, submitPr } from "../../app/service.ts";
import { convergeSlice, submitPrAsSliceSubmit } from "../../app/sliceConverge.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`ConvergeSliceIn` in converge-cell.bpmn) — ADR 0040.
type In = WorkerInputs["pr.converge-slice"];

const handler: AppJobHandler<In, Record<string, never>> = async (job, app) => {
  // No `autoMerge` is passed: `convergeSlice` reads the operator's intent from the durable
  // `plans.auto_merge` column (issue #1007 review, F1), never from a clobberable process variable.
  const res = await convergeSlice(
    app.data,
    { planKey: job.variables.planKey, taskId: job.variables.taskId, prKey: job.variables.prKey },
    submitPrAsSliceSubmit(app.data, app.engine, submitPr, MAX_ROUNDS),
  );
  if (res.enrolled) app.log.info("converge-slice: enrolled slice PR into convergence loop", { planKey: job.variables.planKey, ...res });
  else app.log.warn("converge-slice: no parseable PR key, skipping hand-off", { planKey: job.variables.planKey, prKey: job.variables.prKey });
  return {};
};

export default handler;
