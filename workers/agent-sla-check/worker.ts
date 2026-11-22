// pr.agent-sla-check — the delivery-graph agent-node work-SLA check (issue #1016).
//
// Runs as `<el>_slaChk` on the compiled agent node's SERIAL `<slaCheckEvery>` (min(nodeTimeout,
// AGENT_SLA_CHECK_MAX_INTERVAL)) timer→check loop inside `<el>_work` (see `agentSlaCheckLines` in
// app/deliveryGraphCompiler.ts). It never cancels the live job: it reads the durable activation
// ledger (populated by the poller) and returns
//   • `agentSlaExpired: true`  — the work SLA has elapsed SINCE ACTIVATION: the expiry sets
//     `<el>_slaExpired`, firing the INTERRUPTING conditional boundary `<el>_slaBe` on `<el>_work`
//     into the timeout escalation, with `agentSlaReason` stating the worker + activation time;
//   • `agentSlaExpired: false` — still queued, activation not yet observed, or within budget: the
//     loop arms the next timer fire and the job keeps running.
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

/** Job states an UNFINISHED attempt of the watched task can be in, in PRIORITY tiers. A live attempt
 * (CREATED, or retry-exhausted FAILED parked on an incident) is the node's current attempt. An
 * ERROR_THROWN attempt is terminal in the engine and is NOT cancelled when an operator retries, so it
 * is only a FALLBACK when no live attempt exists — otherwise a historical errored job would collide
 * with the retry's CREATED job and blind the retry's SLA (fail-closed on null). */
export const WATCHED_JOB_STATE_TIERS = [["CREATED", "FAILED"], ["ERROR_THROWN"]] as const;
export const WATCHED_JOB_STATES = WATCHED_JOB_STATE_TIERS.flat();

/** The engine job key of the watched agent task's current attempt: the single job in the highest-priority
 * non-empty tier, or `null` when it cannot be pinned to exactly one job (none, several in that tier, or the
 * search failed) — the check then fails closed. */
export async function currentWatchedJobKey(
  engine: Pick<EngineClient, "searchJobs">,
  processInstanceKey: string,
  elementId: string,
): Promise<string | null> {
  if (processInstanceKey.length === 0 || elementId.length === 0) return null;
  try {
    for (const tier of WATCHED_JOB_STATE_TIERS) {
      const jobs = (await Promise.all(tier.map((state) => engine.searchJobs({ processInstanceKey, elementId, state })))).flat();
      const byKey = new Map(jobs.map((j) => [j.jobKey, j]));
      const live = [...byKey.values()].filter((j) => j.elementId === undefined || j.elementId === elementId);
      if (live.length === 0) continue;
      return live.length === 1 && live[0].jobKey.length > 0 ? live[0].jobKey : null;
    }
    return null;
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
