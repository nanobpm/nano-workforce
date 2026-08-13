// pr.converge-feature — hand a single-issue run's opened PR to the convergence loop (issue #172).
//
// Reached only via the `converge?` gateway's true branch (converge requested AND the agent opened a
// keyed PR). Reuses `submitPr` — the SAME enrollment the epic waves and the standalone
// `startConvergenceLoop` action use — so a feature run's PR gets identical review-round + merge
// behaviour with no duplicated machinery. `autoMerge` maps to `submitPr`'s `convergeOnly`
// (inverted): auto-merge → drive the merge-loop; otherwise stop at `converged`.
//
// The feature-run's OWN process ends here; the PR's live convergence/merge state lives on the
// `pull_requests` row keyed by `pr_key`, which the feature page links to. We therefore leave the
// `feature_runs` row in the terminal `converging` status (NOT an active status), so the
// instanceTracking reconciler does not mark it `abandoned` when feature.bpmn completes.
import type { AppJobHandler } from "@nanobpm/urban";
import { featureRuns } from "../../app/feature.ts";
import { MAX_ROUNDS, parsePr, submitPr } from "../../app/service.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`ConvergeFeatureIn` in feature.bpmn) — ADR 0040.
type In = WorkerInputs["pr.converge-feature"];

const handler: AppJobHandler<In, Record<string, never>> = async (job, app) => {
  const featureKey = job.variables.featureKey;
  const prKey = typeof job.variables.prKey === "string" ? job.variables.prKey.trim() : "";
  const autoMerge = job.variables.autoMerge === true;
  const parsed = prKey ? parsePr(prKey) : null;
  if (!parsed) {
    // Should not happen — the gateway only routes here when record-feature emitted a parseable
    // prKey — but never enroll a phantom PR. Leave the row `opened` and end.
    app.log.warn("converge-feature: no parseable PR key, skipping hand-off", { featureKey, prKey });
    await featureRuns(app.data).update(featureKey, { status: "opened", updated_at: new Date().toISOString() });
    return {};
  }
  // `convergeOnly` is the inverse of auto-merge: converge-only stops at `converged`; auto-merge lets
  // the merge-loop drive the merge. `submitPr` is idempotent on the PR key.
  await submitPr(app.data, app.engine, parsed, [], MAX_ROUNDS, !autoMerge);
  await featureRuns(app.data).update(featureKey, {
    status: "converging",
    pr_key: parsed.prKey,
    updated_at: new Date().toISOString(),
  });
  app.log.info("converge-feature: enrolled PR into convergence loop", {
    featureKey,
    prKey: parsed.prKey,
    convergeOnly: !autoMerge,
  });
  return {};
};

export default handler;
