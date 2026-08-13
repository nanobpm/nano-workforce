// pr.resolve-trial-attention — clear the wave's trial-merge "Needs attention" audit rows once a
// human has made a decision on the trial-merge escalation (issue #69 / #131 follow-up).
//
// Before the escalations were converted to native userTasks, the app-side answer path called
// `resolveTrialMergeAttention` so that a `proceed` override (which records no re-run row and so
// would otherwise pin the red `plan_trial_merges` row in the epic page's "Needs attention" tab
// forever) cleared the wave. The userTask refactor retired that app-side path, leaving this
// cleanup uncalled. This serviceTask restores it in the process: it runs on EVERY answer variant
// (proceed / rebase / abandon) between the `trial-merge-decision` userTask and the answer gateway,
// so the human's decision always clears the wave. It is idempotent w.r.t. a `rebase` re-run, which
// records a fresh unresolved row that supersedes any prior (so re-resolving here changes nothing).
//
// Cleanup is best-effort/cosmetic: a transient failure must never wedge the plan, so it is caught
// and logged rather than thrown.
import type { AppJobHandler } from "@nanobpm/urban";
import { resolveTrialMergeAttention } from "../../app/trialMerge.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`ResolveTrialAttentionIn` in plan-fanout.bpmn) — ADR 0040.
type In = WorkerInputs["pr.resolve-trial-attention"];

const waveNo = (v: unknown): number => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

const handler: AppJobHandler<In> = async (job, app) => {
  const planKey = job.variables.planKey;
  const wave = waveNo(job.variables.trialMergeWave ?? job.variables.currentWave);
  try {
    const cleared = await resolveTrialMergeAttention(app.data, planKey, wave);
    if (cleared > 0) {
      app.log.info(`resolve-trial-attention: cleared ${cleared} row(s) for ${planKey} wave ${wave}`);
    }
  } catch (err) {
    app.log.error(`resolve-trial-attention: cleanup failed for ${planKey} wave ${wave}`, { err: String(err) });
  }
  return {};
};

export default handler;
