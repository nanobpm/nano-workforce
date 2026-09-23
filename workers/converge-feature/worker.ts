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
  // Write `converging` BEFORE enrolling the PR (issue #808 / PR #809 review). The old order —
  // `submitPr` then the status write — left an `opened` + `converge=1` + `pr_key` window spanning an
  // ALREADY-SUBMITTED, live PR: a terminate/crash in that gap stranded a row whose PR was live while
  // `pollFeatureDelivery`'s handoff edge (edge 3) read the FEATURE instance state alone and wrongly
  // folded it to `abandoned`. Flipping to `converging` first shrinks the interrupted-handoff window to
  // the (now converging-owned) gap BEFORE `submitPr`, which `pollFeatureDelivery`'s converging edge
  // (edge 1) heals by re-enrolling when the PR row is still missing (idempotent, mirroring the
  // promotion-PR re-enroll in `pollPromotion`). The reorder is safe: `submitPr` is idempotent on the PR
  // key (it early-returns `alreadyRunning` for a non-terminal PR), and a `converging` row is owned by
  // edge (1), never by the handoff edge. `convergeOnly` is the inverse of auto-merge: converge-only
  // stops at `converged`; auto-merge lets the merge-loop drive the merge.
  await featureRuns(app.data).update(featureKey, {
    status: "converging",
    pr_key: parsed.prKey,
    updated_at: new Date().toISOString(),
  });
  await submitPr(app.data, app.engine, parsed, [], MAX_ROUNDS, !autoMerge, featureKey);
  app.log.info("converge-feature: enrolled PR into convergence loop", {
    featureKey,
    prKey: parsed.prKey,
    convergeOnly: !autoMerge,
  });
  return {};
};

export default handler;
