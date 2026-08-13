// pr.retro-gather — first step of the `retro` process. Assemble the plan's accumulated
// coordination knowledge (the `learning` blackboard entries agents posted while implementing, plus
// the task-delta rollup and any other blackboard notes) into a compact markdown brief, and emit it
// as `retroDigest`. The next step maps that onto the `senior:retro` agent's `appendPrompt`, so the
// agent reflects on real material rather than re-deriving it.
import type { AppJobHandler } from "@nanobpm/urban";
import { gatherRetro, renderRetroBrief } from "../../app/retro.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`RetroGatherIn` in retro.bpmn) — ADR 0040.
type In = WorkerInputs["pr.retro-gather"];

interface Out extends Record<string, unknown> {
  retroDigest: string;
  retroLearnings: number;
}

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const planKey = job.variables.planKey;
  const digest = await gatherRetro(app.data, planKey);
  app.log.info(`retro-gather: ${planKey} — ${digest.counts.learnings} learnings, ${digest.counts.deltas} deltas`);
  return {
    retroDigest: renderRetroBrief(digest),
    retroLearnings: digest.counts.learnings,
  };
};

export default handler;
