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
  // `autoMerge` is forwarded as a NARROW-ONLY signal (issue #1007 review, round 3): the trial-merge
  // Abandon arm maps `autoMerge=false` (the operator's explicit merge opt-out for the wave), while
  // every other arm leaves it unset so the epic's durable `plans.auto_merge` row governs. An input
  // `true` never widens an opted-out epic — `convergeSlice` ANDs the two.
  const res = await convergeSlice(
    app.data,
    { planKey: job.variables.planKey, taskId: job.variables.taskId, prKey: job.variables.prKey, autoMerge: job.variables.autoMerge },
    submitPrAsSliceSubmit(app.data, app.engine, submitPr, MAX_ROUNDS),
  );
  if (res.enrolled) app.log.info("converge-slice: enrolled slice PR into convergence loop", { planKey: job.variables.planKey, ...res });
  else app.log.warn("converge-slice: no parseable PR key, skipping hand-off", { planKey: job.variables.planKey, prKey: job.variables.prKey });
  return {};
};

export default handler;
