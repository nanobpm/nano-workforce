// pr.record-trial-merge — persist the D3 trial-merge gate result and shape the BPMN gateway vars.
// Only `suite-failed` escalates. `clean` and textual `merge-conflict` proceed; D2/D6 own textual
// conflict ordering, while D3 owns clean-merge/combined-suite-red semantic conflicts.
import type { AppJobHandler } from "@nanobpm/urban";
import { agentSlaEscalationQuestion } from "../../app/agentSlaEscalation.ts";
import {
  recordTrialMergeAudit,
  type TrialMergeResult,
  trialMergeDecision,
  trialMergeTaskId,
} from "../../app/trialMerge.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`RecordTrialMergeIn` in plan-fanout.bpmn) — ADR 0040.
// The `waveOpenHeads[]` array field is a `nano:reference` to the `RecordTrialMergeHead` shape, and
// `conflicts[]` / `failing[]` are scalar `list="true"` extends, so all three resolve from the model
// with no hand-written interface.
type In = WorkerInputs["pr.record-trial-merge"];
interface Out extends Record<string, unknown> {
  trialMergeRed: boolean;
  question?: string;
  task?: { id: string; title: string };
  summary?: string;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
const waveNo = (v: unknown): number => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const safeJson = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

function parseResult(v: unknown): TrialMergeResult {
  const s = typeof v === "string" ? v.trim() : "";
  if (s === "clean" || s === "merge-conflict" || s === "suite-failed") return s;
  return "suite-failed";
}

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const planKey = job.variables.planKey;
  const wave = waveNo(job.variables.trialMergeWave ?? job.variables.currentWave);
  const result = parseResult(job.variables.result);
  // Agent-task SLA path (issue #879): the interrupting SLA timer boundary routed here with
  // `agentSlaJobType` set, so there is no agent result — build the accurate never-started-vs-hung
  // summary (named job type + wait duration) from the durable activation ledger instead of the old
  // blanket "hung or looping" wording. On every other caller (a real agent result, the plan-fanout D3
  // gate) `agentSlaJobType` is unset and the summary is derived from the agent's own `summary`/result.
  const slaJobType = str(job.variables.agentSlaJobType);
  const slaSummary = slaJobType
    ? await agentSlaEscalationQuestion(app.data, {
        processInstanceKey: job.processInstanceKey != null ? String(job.processInstanceKey) : "",
        jobType: slaJobType,
        sla: str(job.variables.agentSlaTimeout) ?? "PT2H",
        recovery: "Acknowledge to record the timeout, then decide whether to rerun the trial merge.",
      })
    : undefined;
  const summary = slaSummary ?? str(job.variables.summary) ??
    (result === "suite-failed" ? "Trial merge suite failed or returned no machine-readable result" : result);
  const legacyJobKey = Reflect.get(job, "key");
  const jobKey = job.jobKey ?? (legacyJobKey == null ? null : String(legacyJobKey));

  try {
    await recordTrialMergeAudit(app.data, {
      planKey,
      wave,
      result,
      heads: job.variables.waveOpenHeads,
      conflicts: job.variables.conflicts,
      failing: job.variables.failing,
      summary,
      jobKey,
    });
  } catch (err) {
    app.log.error(`record-trial-merge: audit persist failed for ${planKey} wave ${wave}`, { err: String(err) });
  }

  const trialMergeRed = trialMergeDecision(result) === "escalate";
  if (!trialMergeRed) return { trialMergeRed, summary };

  const failing = Array.isArray(job.variables.failing) && job.variables.failing.length > 0
    ? ` Failing: ${safeJson(job.variables.failing).slice(0, 1000)}`
    : "";
  return {
    trialMergeRed,
    summary,
    task: { id: trialMergeTaskId(wave), title: `Trial merge gate for wave ${wave}` },
    question: `${summary}${failing}\n\nD3 needs a human decision: either the PR heads merged cleanly and the combined suite failed, or the trial-merge agent did not return a valid machine-readable result. Decide the design/infrastructure fix, update the PR heads if needed, then answer to rerun the trial merge; answer exactly "proceed" only to override and continue without rerunning.`,
  };
};

export default handler;
export { parseResult };
