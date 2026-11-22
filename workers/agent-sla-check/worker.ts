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

interface In extends Record<string, unknown> {
  jobType?: string | null;
  nodeTimeout?: string | null;
}
interface Out extends Record<string, unknown> {
  agentSlaExpired: boolean;
  agentSlaReason: string;
}

/** The SLA-check element id is `<el>_slaChk`; the watched agent leaf is `<el>_task`. */
export function watchedTaskElement(checkElementId: string): string {
  return `${checkElementId.replace(/_slaChk$/, "")}_task`;
}

/** The engine job key of the watched agent task's LIVE attempt, or `null` when it cannot be pinned to
 * exactly one job (none, several, or the search failed) — the check then fails closed (never expires). */
export async function currentWatchedJobKey(
  engine: Pick<EngineClient, "searchJobs">,
  processInstanceKey: string,
  elementId: string,
): Promise<string | null> {
  if (processInstanceKey.length === 0 || elementId.length === 0) return null;
  try {
    const jobs = await engine.searchJobs({ processInstanceKey, elementId, state: "CREATED" });
    const live = jobs.filter((j) => j.elementId === undefined || j.elementId === elementId);
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
