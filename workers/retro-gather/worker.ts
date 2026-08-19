// pr.retro-gather — first step of the `retro` process. Assemble the plan's accumulated
// coordination knowledge (the `learning` blackboard entries agents posted while implementing, plus
// the task-delta rollup and any other blackboard notes) into a compact markdown brief, emitted as
// `retroDigest`, AND the spec-conformance material (the spec + the landed PRs to examine + the
// deviations raised during implementation) as `conformanceDigest`. The two downstream agent steps
// (`senior:conformance` then `senior:retro`) map these onto their `appendPrompt`, so each reflects
// on real material rather than re-deriving it.
import type { AppJobHandler } from "@nanobpm/urban";
import { readBlackboard } from "../../app/blackboard.ts";
import { gatherConformance, renderConformanceBrief } from "../../app/conformance.ts";
import { gatherRetro, renderRetroBrief } from "../../app/retro.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`RetroGatherIn` in retro.bpmn) — ADR 0040.
type In = WorkerInputs["pr.retro-gather"];

interface Out extends Record<string, unknown> {
  retroDigest: string;
  retroLearnings: number;
  conformanceDigest: string;
}

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const planKey = job.variables.planKey;
  // Both gatherRetro and gatherConformance need the plan's blackboard; scan it once here and share
  // the snapshot so a retro run does a single blackboard read, not one per gatherer.
  const entries = await readBlackboard(app.data, planKey);
  const digest = await gatherRetro(app.data, planKey, entries);
  const conformance = await gatherConformance(app.data, planKey, entries);
  app.log.info(
    `retro-gather: ${planKey} — ${digest.counts.learnings} learnings, ${digest.counts.deltas} deltas, ${conformance.deliveredPrs.length} delivered PR(s)`,
  );
  return {
    retroDigest: renderRetroBrief(digest),
    retroLearnings: digest.counts.learnings,
    conformanceDigest: renderConformanceBrief(conformance),
  };
};

export default handler;
