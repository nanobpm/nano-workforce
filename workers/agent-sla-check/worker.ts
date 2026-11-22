// pr.agent-sla-check — the delivery-graph agent-node work-SLA gate (issue #1016).
//
// Runs on a compiled agent node's `=nodeTimeout` boundary arm (`<el>_slaChk`, see
// `serviceBodyLines` in app/deliveryGraphCompiler.ts). The boundary timer starts when the node is
// ENTERED, so it alone would count QUEUE time as WORK time and escalate a job no worker ever picked up
// ("in-flight work may already exist" — when none can). This check reads the durable activation ledger
// (populated by the poller while the job was live) and returns:
//   • `requeue: true`  — the job was observed queued but never leased: the node re-enters its task
//     (no human escalation; the work SLA has not started).
//   • `requeue: false` + `reason` — the job was activated (or activation is unknown): escalate, stating
//     the activation facts (worker, activation time) instead of guessing.
import type { AppJobHandler } from "@nanobpm/urban";
import { deliveryNodeActivationJobType } from "../../app/agentActivationLedger.ts";
import { deliveryNodeSlaCheck } from "../../app/agentSlaEscalation.ts";

interface In extends Record<string, unknown> {
  jobType?: string | null;
  nodeTimeout?: string | null;
  /** The node's prior re-queue count, bound by the check task's ioMapping from its collision-free control var. */
  agentSlaPriorRequeues?: number | null;
}
interface Out extends Record<string, unknown> {
  agentSlaRequeue: boolean;
  agentSlaReason: string;
  agentSlaRequeues: number;
}

/** The SLA-check element id is `<el>_slaChk`; the watched agent leaf is `<el>_task`. */
export function watchedTaskElement(checkElementId: string): string {
  return `${checkElementId.replace(/_slaChk$/, "")}_task`;
}

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const jobType = typeof job.variables.jobType === "string" ? job.variables.jobType : "";
  const sla = typeof job.variables.nodeTimeout === "string" ? job.variables.nodeTimeout : "";
  const pik = job.processInstanceKey != null ? String(job.processInstanceKey) : "";
  const el = typeof job.elementId === "string" ? job.elementId : "";
  const priorRaw = job.variables.agentSlaPriorRequeues;
  const priorRequeues = typeof priorRaw === "number" && Number.isInteger(priorRaw) && priorRaw > 0 ? priorRaw : 0;
  const { requeue, reason, requeues } = await deliveryNodeSlaCheck(app.data, {
    priorRequeues,
    processInstanceKey: pik,
    activationJobType: deliveryNodeActivationJobType(jobType, watchedTaskElement(el)),
    jobType,
    sla,
  });
  app.log.info("agent-sla-check", { pik, el, jobType, requeue });
  return { agentSlaRequeue: requeue, agentSlaReason: reason, agentSlaRequeues: requeues };
};

export default handler;
