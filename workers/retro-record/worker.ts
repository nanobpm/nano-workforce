// pr.retro-record — final step of the `retro` process. Persist the `senior:retro` agent's result
// into `plan_retros` (016_plan_retro.sql): the outcome status, the promotion PR it opened on the
// target repo (if any), the learning count it distilled, and its summary/report. Advisory only —
// this gates no control flow; it exists so the epic surface can show what the retro concluded.
//
// The agentTask runner hoists the agent's result-JSON keys (`status`, `pr`, `summary`) into
// top-level process variables (same as pr.record-plan-review reads `job.variables.approved`), and
// exposes the raw transcript under the `io.nanobpm.agentResult` envelope's `.output`.
import type { AppJobHandler } from "@nanobpm/urban";
import { recordRetro } from "../../app/retro.ts";

const AGENT_RESULT_KEY = "io.nanobpm.agentResult";
const VALID_STATUSES = new Set(["filed", "skipped", "blocked"]);

interface In extends Record<string, unknown> {
  planKey: string;
  retroLearnings?: number;
  status?: unknown; // filed | skipped | blocked
  pr?: unknown; // "<owner>/<repo>#<n>" of the promotion PR, when filed
  summary?: unknown;
}

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function asStatus(v: unknown, hasPr: boolean): "filed" | "skipped" | "blocked" {
  const s = asStr(v);
  if (s && VALID_STATUSES.has(s)) {
    if (s === "filed" && !hasPr) return "skipped";
    return s as "filed" | "skipped" | "blocked";
  }
  return hasPr ? "filed" : "skipped";
}

const handler: AppJobHandler<In> = async (job, app) => {
  const planKey = job.variables.planKey;

  const rawPrKey = asStr(job.variables.pr);
  // Default to "filed" only when a PR is present; otherwise the agent decided not to file.
  const status = asStatus(job.variables.status, rawPrKey !== null);
  const prKey = status === "filed" ? rawPrKey : null;
  const summary = asStr(job.variables.summary);

  const env = job.variables[AGENT_RESULT_KEY] as { output?: unknown } | undefined;
  const report = typeof env?.output === "string" ? env.output : null;

  await recordRetro(app.data, planKey, {
    status,
    prKey,
    learnings: typeof job.variables.retroLearnings === "number" ? job.variables.retroLearnings : 0,
    summary,
    report,
  });

  app.log("info", `retro-record: ${planKey} — status=${status}${prKey ? ` pr=${prKey}` : ""}`);
  return {};
};

export default handler;
