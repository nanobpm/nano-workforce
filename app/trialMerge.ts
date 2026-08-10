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
  return Number(await table.insert({
    plan_key: row.planKey,
    wave: row.wave,
    result: row.result,
    heads: jsonOrNull(row.heads),
    conflicts: jsonOrNull(row.conflicts),
    failing: jsonOrNull(row.failing),
    summary: row.summary ?? null,
    job_key: jobKey,
    created_at: ts,
    updated_at: ts,
  }));
}
