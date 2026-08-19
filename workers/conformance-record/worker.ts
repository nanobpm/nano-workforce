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
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
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

  const slicesReduced = asInt(job.variables.slicesReduced);
  const slicesNotVerified = asInt(job.variables.slicesNotVerified);
  const deviationsUnraised = asInt(job.variables.deviationsUnraised);
  // Derive `has_deviations` from ground truth rather than trusting the agent's boolean alone: any
  // reduced / not-verified item, or any unraised deviation, means the epic did not cleanly meet its
  // spec. The agent's flag is honoured as an additional trigger but can't suppress a real signal.
  const hasDeviations = job.variables.hasDeviations === true ||
    slicesReduced > 0 || slicesNotVerified > 0 || deviationsUnraised > 0;

  // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
  const env = (job.variables as Record<string, unknown>)[AGENT_RESULT_KEY] as { output?: unknown } | undefined;
  const report = typeof env?.output === "string" ? env.output : null;

  await recordConformance(app.data, planKey, {
    status,
    commentUrl: status === "filed" ? commentUrl : null,
    slicesMet: asInt(job.variables.slicesMet),
    slicesReduced,
    slicesNotVerified,
    deviationsRaised: asInt(job.variables.deviationsRaised),
    deviationsUnraised,
    hasDeviations,
    summary,
    report,
  });

  app.log.info(
    `conformance-record: ${planKey} — status=${status} deviations=${hasDeviations ? "yes" : "no"}`,
  );
  return {};
};

export default handler;
