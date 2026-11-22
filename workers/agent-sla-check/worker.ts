// pr.agent-sla-check — the delivery-graph agent-node work-SLA check (issue #1016).
//
// Runs on a compiled agent node's NON-interrupting `R/<slaCheckEvery>` (min(nodeTimeout, AGENT_SLA_CHECK_MAX_INTERVAL)) cycle boundary (`<el>_slaChk`,
// see `agentSlaCheckLines` in app/deliveryGraphCompiler.ts). It never cancels the live job: it reads
// the durable activation ledger (populated by the poller) and returns
//   • `agentSlaExpired: true`  — the work SLA has elapsed SINCE ACTIVATION: the node throws its SLA
//     error and escalates, with `agentSlaReason` stating the worker + activation time;
//   • `agentSlaExpired: false` — still queued, activation not yet observed, or within budget: the
//     boundary branch just ends and the job keeps running.
import type { AppJobHandler, EngineClient } from "@nanobpm/urban";
import { deliveryNodeActivationJobType } from "../../app/agentActivationLedger.ts";
import { deliveryNodeSlaCheck } from "../../app/agentSlaEscalation.ts";
import type { AGENT_SLA_CHECK_RESULT_VARS } from "../../app/deliveryGraph.ts";

interface In extends Record<string, unknown> {
  jobType?: string | null;
  nodeTimeout?: string | null;
}
// Keys derive from AGENT_SLA_CHECK_RESULT_VARS (reserved agent emit names) so they cannot drift.
type Out = Record<(typeof AGENT_SLA_CHECK_RESULT_VARS)[0], boolean> & Record<(typeof AGENT_SLA_CHECK_RESULT_VARS)[1], string>;

/** The SLA-check element id is `<el>_slaChk`; the watched agent leaf is `<el>_task`. */
export function watchedTaskElement(checkElementId: string): string {
  return `${checkElementId.replace(/_slaChk$/, "")}_task`;
}

/** Job states an UNFINISHED attempt of the watched task can be in. A retry-exhausted attempt parks in
 * FAILED (incident) and a thrown-error attempt in ERROR_THROWN — still the node's current attempt, so
 * it must stay visible or an activated-and-overrun node would never expire (fail-closed on null). */
export const WATCHED_JOB_STATES = ["CREATED", "FAILED", "ERROR_THROWN"] as const;

/** The engine job key of the watched agent task's current (unfinished) attempt, or `null` when it cannot
 * be pinned to exactly one job (none, several, or the search failed) — the check then fails closed. */
export async function currentWatchedJobKey(
  engine: Pick<EngineClient, "searchJobs">,
  processInstanceKey: string,
  elementId: string,
): Promise<string | null> {
  if (processInstanceKey.length === 0 || elementId.length === 0) return null;
  try {
    const jobs = (
      await Promise.all(WATCHED_JOB_STATES.map((state) => engine.searchJobs({ processInstanceKey, elementId, state })))
    ).flat();
    const byKey = new Map(jobs.map((j) => [j.jobKey, j]));
    const live = [...byKey.values()].filter((j) => j.elementId === undefined || j.elementId === elementId);
    return live.length === 1 && live[0].jobKey.length > 0 ? live[0].jobKey : null;
  } catch {
    return null;
  }
}

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const jobType = typeof job.variables.jobType === "string" ? job.variables.jobType : "";
  const sla = typeof job.variables.nodeTimeout === "string" ? job.variables.nodeTimeout : "";
  const pik = job.processInstanceKey != null ? String(job.processInstanceKey) : "";
  const el = typeof job.elementId === "string" ? job.elementId : "";
  const currentJobKey = await currentWatchedJobKey(app.engine, pik, watchedTaskElement(el));
  const { expired, reason } = await deliveryNodeSlaCheck(app.data, {
    processInstanceKey: pik,
    currentJobKey,
    activationJobType: deliveryNodeActivationJobType(jobType, watchedTaskElement(el)),
    jobType,
    sla,
  });
  app.log.info("agent-sla-check", { pik, el, jobType, expired });
  return { agentSlaExpired: expired, agentSlaReason: reason };
};

export default handler;
