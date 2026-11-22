// Agent-task SLA-escalation reason builder (issue #879) — the single canonical, pure text builder for
// the human-facing escalation raised when an agent service task's interrupting SLA timer boundary
// fires. It distinguishes the two outcomes the old wording conflated:
//
//   • NEVER OBSERVED ACTIVATED — no worker was ever observed to pick the job up (almost certainly
//     queue starvation / no capacity for the job type). The job sat CREATED for ~the whole SLA budget
//     and was cancelled by the boundary. Telling the human it is "hung or looping" and to "check its
//     progress" is a false diagnosis — the likely fix is CAPACITY, not intervention. The wording is
//     hedged (a worker could lease it in the final moment before the boundary fires, between activation
//     polls, unrecorded), so it reports the likely cause without over-claiming certainty.
//   • STARTED BUT EXCEEDED — a worker leased the job (an agent ran) but did not complete within the
//     budget — it may genuinely be hung or looping, and intervening / checking its progress is apt.
//
// The distinction is read from the durable activation ledger (`app/agentActivationLedger.ts`), which
// the poller populates while the job is live. Every escalation names the JOB TYPE and HOW LONG it
// waited, per the issue's acceptance criteria.
//
// Derivation over duplication: this is the ONE builder every agent-SLA recorder (implement-cell,
// merge-cell, retro) routes through, so the never-started/hung wording can never drift between sites.
// The pure `buildAgentSlaEscalationReason` is exhaustively testable; `agentSlaEscalationQuestion` is
// the thin async wrapper that reads the ledger and calls it.
import type { DataLayer } from "@nanobpm/urban";
import { type AgentJobActivation, getAgentJobActivation } from "./agentActivationLedger.ts";
import { isoDurationToMs } from "./reviewWait.ts";

/** The activation facts the builder needs (a slice of the ledger row), or `null` when the poller never
 * observed the job (activation unknown). */
export interface AgentSlaActivation {
  /** ISO ts a leasing worker was first observed; `null`/absent ⇒ never activated. */
  activatedAt?: string | null;
  /** ISO ts the job was first observed queued. */
  firstSeenAt?: string | null;
  /** The leasing worker's name, when known. */
  worker?: string | null;
}

export interface AgentSlaEscalationInput {
  /** The agent job type that timed out, e.g. `senior:feature`. Named in the reason. */
  jobType: string;
  /** The SLA budget (ISO-8601 duration) the boundary armed, e.g. `PT2H`. */
  sla: string;
  /** The activation record for this job, or `null` when the poller never observed it. */
  activation: AgentSlaActivation | null;
  /** The escalation moment (ISO ts) — the elapsed wait is measured against it. */
  now: string;
  /** How the human resumes after answering — appended verbatim so each caller keeps its own
   * routing hint (e.g. "answer to resume … or abandon it"). */
  recovery: string;
}

/** Humanise a millisecond span to a compact, human-facing string (e.g. `2h 5m`, `45m`, `30s`). A
 * non-positive/NaN span renders `less than a minute`. */
export function humanizeMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "less than a minute";
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  return parts.join(" ") || "less than a minute";
}

/** Humanise an ISO-8601 duration (the SLA budget) to the same compact form, via the canonical parser. */
export function humanizeIsoDuration(iso: string): string {
  return humanizeMs(isoDurationToMs(iso, iso));
}

const elapsedMs = (fromIso: string | null | undefined, toIso: string): number | null => {
  if (!fromIso) return null;
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return to - from;
};

/** Build the accurate, self-contained agent-SLA escalation reason. Pure — distinguishes never-started
 * (queue starvation) from started-but-hung, names the job type and how long it waited, then appends
 * the caller's recovery hint. */
export function buildAgentSlaEscalationReason(input: AgentSlaEscalationInput): string {
  const { jobType, sla, activation, now, recovery } = input;
  const slaHuman = humanizeIsoDuration(sla);
  const activatedAt = activation?.activatedAt ?? null;

  if (activatedAt) {
    // STARTED BUT EXCEEDED: a worker leased the job, so it may genuinely be hung or looping.
    const queueMs = elapsedMs(activation?.firstSeenAt, activatedAt);
    const queuedClause = queueMs !== null && queueMs > 0
      ? ` (after waiting ~${humanizeMs(queueMs)} in the queue)`
      : "";
    const ranMs = elapsedMs(activatedAt, now);
    const ranClause = ranMs !== null && ranMs > 0 ? ` and then ran for ~${humanizeMs(ranMs)}` : "";
    const workerClause = activation?.worker ? ` (worker "${activation.worker}")` : "";
    return (
      `The ${jobType} agent started${queuedClause}${workerClause}${ranClause} but exceeded its time budget ` +
      `(SLA ${sla} ≈ ${slaHuman}) without completing — it may be hung or looping. ${recovery}`
    );
  }

  // Measure the wait: from first-seen to now when the poller observed the queued job, else the full
  // SLA budget (the boundary fired exactly one budget after the task was entered).
  const waitedMs = elapsedMs(activation?.firstSeenAt, now);
  const waited = waitedMs !== null && waitedMs > 0 ? humanizeMs(waitedMs) : slaHuman;

  if (activation === null) {
    // ACTIVATION UNKNOWN: the poller never observed the job (e.g. the activation poll was unavailable).
    // Report the ambiguity honestly rather than guessing "hung" or "never started".
    return (
      `The ${jobType} agent did not complete within its time budget (SLA ${sla} ≈ ${slaHuman}), and no ` +
      `worker-activation was ever recorded for it, so we cannot confirm whether a worker ever picked it ` +
      `up — it may have been starved of capacity for ${jobType}, or started and hung. ${recovery}`
    );
  }

  // NEVER OBSERVED ACTIVATED: seen queued, never seen leased. This is the best-effort observation of
  // queue starvation — hedged, because a worker could in principle lease the job in the final moment
  // before the boundary cancels it, between activation polls, and that would not be recorded. We report
  // the likely diagnosis (and its capacity fix) without over-claiming certainty.
  return (
    `No worker was ever observed to pick up the ${jobType} agent's job for its entire SLA budget ` +
    `(SLA ${sla} ≈ ${slaHuman}): it was seen queued for ~${waited}, then the SLA boundary cancelled it. ` +
    `This is almost certainly queue starvation (no capacity for ${jobType}) rather than a hung or ` +
    `looping agent, so the likely fix is to add capacity for ${jobType} (enrol a worker that serves it, ` +
    `or reduce concurrent demand) rather than to check a non-existent agent's progress. (If a worker ` +
    `leased it in the final moment before the boundary fired, between activation polls, that would not ` +
    `have been recorded here.) ${recovery}`
  );
}

/** Read the activation ledger for this job and build the escalation reason — the thin async wrapper the
 * recorder workers call. `processInstanceKey` is the instance the agent job AND its SLA recorder share,
 * so the lookup is by (instance, jobType). An absent ledger row ⇒ activation unknown. */
export async function agentSlaEscalationQuestion(
  data: DataLayer,
  input: {
    processInstanceKey: string;
    jobType: string;
    sla: string;
    recovery: string;
    now?: string;
  },
): Promise<string> {
  const now = input.now ?? new Date().toISOString();
  let activation: AgentSlaActivation | null = null;
  if (input.processInstanceKey && input.processInstanceKey.length > 0) {
    const row: AgentJobActivation | undefined = await getAgentJobActivation(
      data,
      input.processInstanceKey,
      input.jobType,
    );
    if (row) {
      activation = {
        activatedAt: row.activated_at,
        firstSeenAt: row.first_seen_at,
        worker: row.worker,
      };
    }
  }
  return buildAgentSlaEscalationReason({
    jobType: input.jobType,
    sla: input.sla,
    activation,
    now,
    recovery: input.recovery,
  });
}

/** Cap on never-activated re-queues per agent node before the SLA check escalates instead (issue #1016):
 * an unserved job type must reach a human, not loop the `=nodeTimeout` boundary forever. */
export const MAX_SLA_REQUEUES = 3;

/** Default freshness window for a "never activated" ledger observation: two default poll intervals
 * (`NANO_PR_POLL_MS` default 60s), so one missed/slow pass still counts as fresh. */
export const DEFAULT_SLA_OBSERVATION_FRESH_MS = 120_000;

/** The delivery-graph agent-node SLA check (issue #1016). The node's interrupting `=nodeTimeout`
 * boundary starts when the node is ENTERED, so on its own it measures queue time as work time. The
 * compiled body routes the boundary through this check: a job the poller observed QUEUED but never
 * leased (`requeue: true`) is re-queued instead of escalated — the work SLA only counts once a worker
 * has picked the job up. Otherwise (`requeue: false`) the node escalates with a `reason` stating the
 * activation FACTS (worker, activation time, or "activation unknown") instead of guessing that
 * "in-flight work may already exist". An absent ledger row (the poller never saw the job) is NOT proof
 * of non-activation, so it escalates with the honest "unknown" wording. */
export async function deliveryNodeSlaCheck(
  data: DataLayer,
  input: {
    processInstanceKey: string;
    activationJobType: string;
    jobType: string;
    sla: string;
    now?: string;
    /** Max age (ms) of the ledger's last observation for a "never activated" reading to be trusted;
     * defaults to {@link DEFAULT_SLA_OBSERVATION_FRESH_MS}. */
    freshWithinMs?: number;
    /** How many times this node has already been re-queued (the node-scoped `<el>_slaRequeues`). */
    priorRequeues?: number;
    /** Re-queue cap; defaults to {@link MAX_SLA_REQUEUES}. */
    maxRequeues?: number;
  },
): Promise<{ requeue: boolean; reason: string; requeues: number }> {
  const prior = Number.isInteger(input.priorRequeues) && (input.priorRequeues ?? 0) > 0 ? (input.priorRequeues ?? 0) : 0;
  const cap = input.maxRequeues ?? MAX_SLA_REQUEUES;
  const now = input.now ?? new Date().toISOString();
  const freshMs = input.freshWithinMs ?? DEFAULT_SLA_OBSERVATION_FRESH_MS;
  const row = input.processInstanceKey.length > 0
    ? await getAgentJobActivation(data, input.processInstanceKey, input.activationJobType)
    : undefined;
  // A never-activated reading is only trusted when the poller observed the job RECENTLY: a worker may
  // have leased it after a stale last pass, so a stale unleased row is "activation unknown" (escalate).
  const ageMs = row ? Date.parse(now) - Date.parse(row.updated_at) : Number.NaN;
  const fresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= freshMs;
  const activation: AgentSlaActivation | null = row && (row.activated_at || fresh)
    ? { activatedAt: row.activated_at, firstSeenAt: row.first_seen_at, worker: row.worker }
    : null;
  const neverActivated = row !== undefined && !row.activated_at && fresh;
  const capped = neverActivated && prior >= cap;
  const requeue = neverActivated && !capped;
  const recovery = activation?.activatedAt
    ? `Activated at ${activation.activatedAt}${activation.worker ? ` by worker "${activation.worker}"` : ""} — check that run's branch/draft PR for partial work before retrying or reassigning.`
    : capped
      ? `Never picked up after ${prior + 1} × ${input.sla} SLA (${prior} re-queues) — check that a worker serves job type "${input.jobType}" (typo in the node's jobType, or no fleet host for it) before retrying.`
      : "Check the job's state before retrying or reassigning.";
  return {
    requeue,
    requeues: requeue ? prior + 1 : prior,
    reason: buildAgentSlaEscalationReason({ jobType: input.jobType, sla: input.sla, activation, now, recovery }),
  };
}
