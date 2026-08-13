// pr.record-feature — the single-issue `implement` block has finished (issue #172).
//
// The `senior:feature` agent reported one of `opened` / `blocked` / `skipped` (prompts/feature.md);
// anything else — including a missing status, or an `escalated` status that fell through to abandon
// (the human abandoned or the SLA fired) — is treated as `blocked`: we must not assume a PR was
// opened. This worker:
//   • resolves the run's terminal status from the agent result,
//   • records the PR key + outcome on the `feature_runs` row,
//   • emits `featureStatus` + `prKey` so the `converge?` gateway can decide whether to hand the
//     opened PR off to the convergence loop.
//
// Enrollment itself lives in the separate `pr.converge-feature` worker (gated by the `converge?`
// branch) so the hand-off is legible in the process, not buried in a persistence step.
import type { AppJobHandler } from "@nanobpm/urban";
import { type FeatureRunStatus, featureRuns } from "../../app/feature.ts";
import { parsePr } from "../../app/service.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`RecordFeatureIn` in feature.bpmn) — ADR 0040.
type In = WorkerInputs["pr.record-feature"];
interface Out extends Record<string, unknown> {
  featureStatus: FeatureRunStatus;
  prKey: string | null;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;

// The implementation agent reports one of these; anything else is `blocked` (we never assume a PR).
type AgentStatus = "opened" | "blocked" | "skipped";
const isAgentStatus = (s: string): s is AgentStatus => s === "opened" || s === "blocked" || s === "skipped";

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const featureKey = job.variables.featureKey;
  const rawStatus = str(job.variables.status);
  const status: AgentStatus = rawStatus && isAgentStatus(rawStatus) ? rawStatus : "blocked";
  const summary = str(job.variables.summary);
  const prRef = str(job.variables.pr);
  // Only trust a PR ref when the agent reports it actually opened one.
  const parsed = status === "opened" && prRef ? parsePr(prRef) : null;
  // A keyless "opened" cannot be handed off, but a PR was still raised — keep the status `opened`
  // (the run is complete), just with no `pr_key` to converge.
  const prKey = parsed?.prKey ?? null;
  const featureStatus: FeatureRunStatus = status;
  const ts = new Date().toISOString();

  await featureRuns(app.data).update(featureKey, {
    status: featureStatus,
    pr_key: prKey,
    outcome: summary ?? null,
    updated_at: ts,
  });
  app.log.info("record-feature", { featureKey, featureStatus, prKey });

  return { featureStatus, prKey };
};

export default handler;
