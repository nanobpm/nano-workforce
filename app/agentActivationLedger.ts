// Agent-job activation ledger (issue #879) — the durable "did a worker ever pick this agent job up?"
// record every agent-task SLA-escalation reads to tell a NEVER-ACTIVATED (queue-starved) job apart
// from an ACTIVATED-but-hung one.
//
// Why it exists: an agent-task SLA boundary timer (`<bpmn:timeDuration>=agentSlaTimeout`) starts when
// the service task is ENTERED, so it bounds QUEUE time + RUN time together. Under fleet saturation a
// job can sit CREATED (no worker can take its type) for the whole budget and the boundary fires — but
// the escalation reported it as "hung or looping" and told the human to "check its progress" when
// there is none (issue #879: a `senior:feature` job queued 2h, never activated, then SLA-cancelled).
// The engine knows JobState::Created vs ::Activated, but once the boundary CANCELS the job that state
// is gone — so the observation must be captured WHILE the job is live and persisted. `pollAgentActivations`
// (app/service.ts) does exactly that, writing this ledger; the SLA-escalation recorders read it.
//
// The activation signal is the same one the review-round visibility uses (migration 005): the
// Camunda-8 `/v2/jobs/search` wire API collapses Activated -> CREATED (no ACTIVATED enum), so a leased
// job is recognised by its `worker` + `deadline` fields — a merely-queued job carries neither. This
// ledger generalises that to EVERY bounded agent job type and persists first-seen + first-activated.
//
// Advisory & best-effort (ADR 0056): this is an app-tier read model over the engine's job read model.
// It never activates/completes a job, publishes a message, or gates a BPMN sequence flow — it only
// enriches the human-facing escalation wording. A missing row (poller never observed the job) degrades
// to "activation unknown", never an error.
import type { DataLayer } from "@nanobpm/urban";

/** The agent job types that today carry an interrupting SLA timer boundary whose elapse escalates to a
 * human with a "hung or looping" reason — the class issue #879 guards. Kept as one list so the
 * activation poll's `/v2/jobs/search` type filter and the escalation recorders agree on exactly which
 * jobs are tracked. (The convergence-loop / plan-fanout agent tasks are NOT yet bounded — pre-seeded
 * for #868 — so they are deliberately absent until their boundaries land.) */
export const AGENT_SLA_JOB_TYPES: readonly string[] = [
  "senior:feature", // implement-cell
  "senior:trial-merge", // merge-cell
  "senior:conformance", // retro conformance
  "senior:retro", // retro synthesize
  "senior:fix-ci", // merge-loop CI-fix cell (be_fixci_sla)
  "senior:rebase", // merge-loop rebase cell (be_rebase_sla)
];

/** One ledger row: whether (and when) a worker picked up an agent job for a given process instance. */
export interface AgentJobActivation {
  /** Surrogate key `<process_instance_key>:<job_type>`. */
  id: string;
  process_instance_key: string;
  job_type: string;
  /** ISO ts the poller first observed the job (queued/CREATED). */
  first_seen_at: string;
  /** ISO ts first observed ACTIVATED (a leasing worker appeared); NULL ⇒ never started. */
  activated_at: string | null;
  /** The leasing worker's name at activation; NULL until activated. */
  worker: string | null;
  /** The engine job key of the attempt this row currently tracks; NULL when unknown (an old row or a
   * caller that did not supply one). A poll observation carrying a DIFFERENT job key is a new attempt
   * and resets the row — see {@link recordAgentJobObservation}. */
  job_key: string | null;
  updated_at: string;
}

/** The surrogate key for a (process instance, job type) pair — the agent job and its SLA-escalation
 * recorder share one process instance, so both sides key the ledger identically. */
export function agentActivationId(processInstanceKey: string, jobType: string): string {
  return `${processInstanceKey}:${jobType}`;
}

/** Record gateway over the activation ledger. */
export const agentActivations = (data: DataLayer) =>
  data.table<AgentJobActivation>("agent_job_activations", "id");

/** Upsert one poll observation of an agent job. On first sight records `first_seen_at`; the FIRST time
 * a leasing `worker` is observed it records `activated_at` + `worker` (a later re-observation of the
 * SAME attempt never moves the first-activation timestamp). Idempotent on a steady state.
 *
 * Retry isolation (issue #879 review): the same (process instance, job type) runs MULTIPLE times within
 * one instance when its cell retries (`ic_reImplement`, `mc_rerun`, merge-loop fix-ci/rebase reloops).
 * Each attempt is a distinct engine job with its own `jobKey`, so when an observation carries a job key
 * DIFFERENT from the one the row tracks, it is a NEW attempt and the row is RESET to it (first_seen_at /
 * activated_at / worker), discarding the earlier attempt's activation. Without this a sticky
 * first-activation row would make a later queued retry read the earlier attempt's worker and misdiagnose
 * a queue-starved retry as started/hung, and its elapsed times would fold in the prior attempt + human
 * wait. When the job key is unknown on either side the row keeps its prior first-sticky-activation
 * behaviour (the caller cannot prove a new attempt). */
export async function recordAgentJobObservation(
  data: DataLayer,
  input: {
    processInstanceKey: string;
    jobType: string;
    worker: string | null;
    jobKey?: string | null;
    now: string;
  },
): Promise<void> {
  const table = agentActivations(data);
  const id = agentActivationId(input.processInstanceKey, input.jobType);
  const worker = input.worker && input.worker.length > 0 ? input.worker : null;
  const jobKey = input.jobKey && input.jobKey.length > 0 ? input.jobKey : null;
  const existing = await table.get(id);
  if (!existing) {
    await table.insert({
      id,
      process_instance_key: input.processInstanceKey,
      job_type: input.jobType,
      first_seen_at: input.now,
      activated_at: worker ? input.now : null,
      worker,
      job_key: jobKey,
      updated_at: input.now,
    });
    return;
  }
  const existingKey = existing.job_key && existing.job_key.length > 0 ? existing.job_key : null;
  // A different engine job key for the same (instance, jobType) is a NEW attempt — reset the row so it
  // reflects only the current attempt, never a stale earlier activation/wait.
  if (jobKey && existingKey && jobKey !== existingKey) {
    await table.update(id, {
      first_seen_at: input.now,
      activated_at: worker ? input.now : null,
      worker,
      job_key: jobKey,
      updated_at: input.now,
    });
    return;
  }
  // Same attempt (or job key unknown): capture the FIRST activation only, and adopt a newly-known job
  // key so a subsequent different one is recognised as a new attempt.
  const patch: Partial<AgentJobActivation> = {};
  if (worker && !existing.activated_at) {
    patch.activated_at = input.now;
    patch.worker = worker;
  }
  if (jobKey && !existingKey) patch.job_key = jobKey;
  if (Object.keys(patch).length > 0) {
    patch.updated_at = input.now;
    await table.update(id, patch);
  }
}

/** Read the activation record for a (process instance, job type), or `undefined` when the poller never
 * observed the job. */
export async function getAgentJobActivation(
  data: DataLayer,
  processInstanceKey: string,
  jobType: string,
): Promise<AgentJobActivation | undefined> {
  return agentActivations(data).get(agentActivationId(processInstanceKey, jobType));
}
