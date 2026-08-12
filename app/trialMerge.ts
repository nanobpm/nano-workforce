// Trial-merge integration gate (D3, issue #69).
//
// D3 catches semantic conflicts between concurrently-open PR heads: if they merge cleanly but the
// target repo's combined suite fails, a human/agent design decision is required. Textual merge
// conflicts are explicitly pass-through because D2/D6 own merge-exclusion and merge-train ordering.
import type { DataLayer } from "@nanobpm/urban";
import type { MergeProtocol } from "./mergeProtocol.ts";

const now = () => new Date().toISOString();

export type TrialMergeResult = "clean" | "merge-conflict" | "suite-failed";
export type TrialMergeDecision = "proceed" | "escalate";

export interface TrialMergeHead {
  repo: string;
  prNumber: number | string;
  headRef?: string;
  headSha?: string;
}

export interface TrialMergeAuditRow {
  id: number;
  plan_key: string;
  wave: number;
  result: TrialMergeResult;
  heads: string | null;
  conflicts: string | null;
  failing: string | null;
  summary: string | null;
  job_key: string | null;
  resolved: number;
  created_at: string;
  updated_at: string;
}

export const TRIAL_MERGE_TASK_PREFIX = "trial-merge-wave-";

export function trialMergeDecision(result: TrialMergeResult): TrialMergeDecision {
  return result === "suite-failed" ? "escalate" : "proceed";
}

export function shouldRunTrialMerge(headCount: number, protocol: Pick<MergeProtocol, "land">): boolean {
  return headCount >= 2 && protocol.land.method !== "mergify-queue";
}

export function trialMergeTaskId(wave: number): string {
  return `${TRIAL_MERGE_TASK_PREFIX}${Math.max(0, Math.trunc(wave))}`;
}

/** Inverse of {@link trialMergeTaskId}: the wave a trial-merge escalation
 * `task_id` refers to, or `null` when `taskId` is not a trial-merge escalation
 * (e.g. an ordinary feature escalation). */
export function trialMergeWaveFromTaskId(taskId: string): number | null {
  if (!taskId.startsWith(TRIAL_MERGE_TASK_PREFIX)) return null;
  const wave = Number(taskId.slice(TRIAL_MERGE_TASK_PREFIX.length));
  return Number.isInteger(wave) && wave >= 0 ? wave : null;
}

const auditTable = (data: DataLayer) => data.table<TrialMergeAuditRow>("plan_trial_merges", "id");

function jsonOrNull(v: unknown): string | null {
  if (v == null) return null;
  try {
    return JSON.stringify(v);
  } catch {
    return JSON.stringify(String(v));
  }
}

export async function recordTrialMergeAudit(
  data: DataLayer,
  row: {
    planKey: string;
    wave: number;
    result: TrialMergeResult;
    heads?: unknown;
    conflicts?: unknown;
    failing?: unknown;
    summary?: string | null;
    jobKey?: string | null;
  },
): Promise<number> {
  const ts = now();
  const table = auditTable(data);
  const jobKey = row.jobKey ?? null;
  if (jobKey) {
    const existing = (await table.find({ plan_key: row.planKey, job_key: jobKey })).sort((a, b) => b.id - a.id)[0];
    if (existing) {
      // Same job re-reporting (a retry before its wait subscription opened):
      // update in place — it is the same logical attempt, not a supersede.
      await table.update(existing.id, {
        result: row.result,
        heads: jsonOrNull(row.heads),
        conflicts: jsonOrNull(row.conflicts),
        failing: jsonOrNull(row.failing),
        summary: row.summary ?? null,
        updated_at: ts,
      });
      return existing.id;
    }
  }
  // A fresh audit row for this wave supersedes every prior row for the same
  // (plan_key, wave): those are now history, so mark them resolved. Without this
  // the append-only log leaves an old red row in the page's "Needs attention"
  // tab forever, even after the wave was re-run clean (issue: the tab never
  // cleared). The newly-inserted row defaults `resolved = 0`, so a still-red
  // latest attempt keeps showing until it too is superseded or answered.
  for (const prior of await table.find({ plan_key: row.planKey, wave: row.wave })) {
    if (prior.resolved !== 1) await table.update(prior.id, { resolved: 1, updated_at: ts });
  }
  return Number(await table.insert({
    plan_key: row.planKey,
    wave: row.wave,
    result: row.result,
    heads: jsonOrNull(row.heads),
    conflicts: jsonOrNull(row.conflicts),
    failing: jsonOrNull(row.failing),
    summary: row.summary ?? null,
    job_key: jobKey,
    resolved: 0,
    created_at: ts,
    updated_at: ts,
  }));
}

/** Mark every trial-merge audit row for `(planKey, wave)` resolved, so the epic
 * page's "Needs attention" tab stops surfacing it. Called when the wave's trial
 * escalation is answered — including a "proceed" override that records no
 * re-run row and so would otherwise leave the old red row pinned forever.
 * Returns the number of rows newly resolved. */
export async function resolveTrialMergeAttention(
  data: DataLayer,
  planKey: string,
  wave: number,
): Promise<number> {
  const table = auditTable(data);
  const ts = now();
  let resolved = 0;
  for (const r of await table.find({ plan_key: planKey, wave })) {
    if (r.resolved !== 1) {
      await table.update(r.id, { resolved: 1, updated_at: ts });
      resolved++;
    }
  }
  return resolved;
}
