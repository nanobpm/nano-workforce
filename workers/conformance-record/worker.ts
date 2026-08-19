// pr.conformance-record — persist the `senior:conformance` agent's result into `plan_conformance`
// (052_plan_conformance.sql): the outcome status, the report comment it posted on the epic issue,
// the per-item verdict counts, and the two deviation counts (raised / unraised). Advisory only —
// this gates no control flow; it exists so the epic surface can show what the conformance audit
// concluded, and (in a later slice) drive escalation off `has_deviations`.
//
// The agentTask runner hoists the agent's result-JSON keys (`status`, `commentUrl`, the counts,
// `hasDeviations`, `summary`) into top-level process variables (same mechanism pr.retro-record
// reads `status`/`pr`/`summary` through), and exposes the raw transcript under the
// `io.nanobpm.agentResult` envelope's `.output`.
import type { AppJobHandler } from "@nanobpm/urban";
import { recordConformance } from "../../app/conformance.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

const AGENT_RESULT_KEY = "io.nanobpm.agentResult";

// Input typed off the model data envelope (`ConformanceRecordIn` in retro.bpmn) — ADR 0040.
type In = WorkerInputs["pr.conformance-record"];

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function asInt(v: unknown): number {
  // Tolerate a numeric string ("1") too — the agentTask runner hoists result-JSON keys as-is, and an
  // agent may emit counts as strings; silently coercing those to 0 would wrongly clear the verdict.
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

// Tolerant boolean coercion mirroring record-plan-review's `isApproved`: honour boolean `true` OR a
// case-insensitive "true" string, so a stringified flag the agent hoists isn't silently dropped.
function asBool(v: unknown): boolean {
  return v === true || (typeof v === "string" && v.trim().toLowerCase() === "true");
}

function asStatus(v: unknown, hasComment: boolean): "filed" | "skipped" | "blocked" {
  const s = asStr(v);
  if (s === "filed" || s === "skipped" || s === "blocked") {
    // A "filed" with no report comment is not really filed — downgrade to skipped so the record
    // never claims a report a human can't open.
    if (s === "filed" && !hasComment) return "skipped";
    return s;
  }
  return hasComment ? "filed" : "skipped";
}

const handler: AppJobHandler<In> = async (job, app) => {
  const planKey = job.variables.planKey;

  const commentUrl = asStr(job.variables.commentUrl);
  const status = asStatus(job.variables.status, commentUrl !== null);
  const summary = asStr(job.variables.summary);

  // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
  const env = (job.variables as Record<string, unknown>)[AGENT_RESULT_KEY] as { output?: unknown } | undefined;
  const report = typeof env?.output === "string" ? env.output : null;

  // Only a "filed" audit produced a verified verdict; a skipped/blocked one has no trustworthy
  // per-item counts or deviations, so persist zeros rather than whatever the agent hoisted. This
  // keeps the row internally consistent (no status="skipped" with has_deviations=1) and honours the
  // schema/prompt contract that skipped/blocked audits omit counts. summary + report are retained as
  // human-readable context explaining why the audit didn't file.
  const filed = status === "filed";
  const slicesReduced = filed ? asInt(job.variables.slicesReduced) : 0;
  const slicesNotVerified = filed ? asInt(job.variables.slicesNotVerified) : 0;
  const deviationsUnraised = filed ? asInt(job.variables.deviationsUnraised) : 0;
  // Derive `has_deviations` from ground truth rather than trusting the agent's boolean alone: any
  // reduced / not-verified item, or any unraised deviation, means the epic did not cleanly meet its
  // spec. The agent's flag is honoured as an additional trigger but can't suppress a real signal.
  // Forced false for a non-filed audit (all counts are zeroed above, and there is no verified verdict).
  const hasDeviations = filed &&
    (asBool(job.variables.hasDeviations) ||
      slicesReduced > 0 || slicesNotVerified > 0 || deviationsUnraised > 0);

  // Track this retro instance on the conformance row so `pollUserTasks` can find the escalation ack
  // task, but only mark it `reviewing` when there IS something to escalate — a clean run settles
  // straight to `reviewed` and never enters the inbox scan (migration 053). Coerce the instance key
  // to a string (the engine can hand back a numeric key) so `plan_conformance.process_key` (TEXT)
  // never drifts to a number and break the string-filter reads in `pollUserTasks`/`openUserTasks` —
  // the same `String(...)` coercion app/service.ts applies when it stamps `process_key`.
  const processKey = job.processInstanceKey != null ? String(job.processInstanceKey) : null;
  await recordConformance(app.data, planKey, {
    status,
    commentUrl: filed ? commentUrl : null,
    slicesMet: filed ? asInt(job.variables.slicesMet) : 0,
    slicesReduced,
    slicesNotVerified,
    deviationsRaised: filed ? asInt(job.variables.deviationsRaised) : 0,
    deviationsUnraised,
    hasDeviations,
    summary,
    report,
    processKey,
    // Only enter the `reviewing` inbox scan when we actually have a `processKey` to key off — a
    // null key can never be found by `pollUserTasks` (it skips rows without `process_key`) nor
    // cleared by the `instanceTracking` `onTerminated` binding, so a `reviewing` row with no key
    // would wedge forever. Settle straight to `reviewed` in that (defensive) case.
    reviewStatus: hasDeviations && processKey != null ? "reviewing" : "reviewed",
  });

  app.log.info(
    `conformance-record: ${planKey} — status=${status} deviations=${hasDeviations ? "yes" : "no"}`,
  );
  // Return the ground-truth `hasDeviations` as a process variable so the `gw-deviations` gateway
  // routes to the human ack task (retro.bpmn) — overriding the agent's hoisted flag with the value
  // reconciled against the recorded counts above.
  return { hasDeviations };
};

export default handler;
