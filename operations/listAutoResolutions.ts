// GET /app/api/auto-resolutions → operationId `listAutoResolutions` (issue #889). The read door for
// the Auto-resolutions view + the matching MCP tool: list the escalation steward's durable,
// reviewable records (every escalation it resolved or abstained from), newest first, filtered by
// `reviewState` / `subject` / `kind`. Read-only projection over the ONE `escalation_auto_resolutions`
// table (app/escalationSteward.ts) — no second source of truth. The optional shared-secret guard
// mirrors `listEscalations`.
import {
  type EscalationAutoResolution,
  listAutoResolutions,
  pendingAutoResolutionCount,
} from "../app/escalationSteward.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

/** Project one stored row into its API/read-tool entry (camelCase, parsed JSON fields). */
function toView(r: EscalationAutoResolution) {
  const parseJsonArray = (s: string | null): unknown[] | null => {
    if (s == null) return null;
    try {
      const v: unknown = JSON.parse(s);
      return Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };
  const parseJsonObject = (s: string | null): { [key: string]: unknown } | null => {
    if (s == null) return null;
    try {
      const v: unknown = JSON.parse(s);
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        // biome-ignore lint/plugin: narrowing a parsed JSON object to a string-keyed record (validated object above)
        return v as { [key: string]: unknown };
      }
      return null;
    } catch {
      return null;
    }
  };
  return {
    id: r.id,
    userTaskKey: r.user_task_key,
    kind: r.escalation_kind,
    elementId: r.element_id,
    subjectType: r.subject_type,
    subjectKey: r.subject_key,
    subjectUrl: r.subject_url,
    processInstanceKey: r.process_instance_key,
    question: r.question,
    options: parseJsonArray(r.options),
    outcome: r.outcome === "resolved" ? ("resolved" as const) : ("abstained" as const),
    submittedVariables: parseJsonObject(r.submitted_variables),
    rationale: r.rationale,
    evidence: r.evidence,
    stewardInstanceKey: r.steward_instance_key,
    agentJobKey: r.agent_job_key,
    worker: r.worker,
    model: r.model,
    createdAt: r.created_at,
    reviewState: r.review_state,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    reviewNote: r.review_note,
  };
}

export default defineOperation("listAutoResolutions", async ({ query, req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("listAutoResolutions rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
  const reviewState = str(query.reviewState);
  const subject = str(query.subject);
  const kind = str(query.kind);
  const records = (await listAutoResolutions(app.data, { reviewState, subjectKey: subject, kind })).map(toView);
  const pendingCount = await pendingAutoResolutionCount(app.data);
  return { status: 200, body: { count: records.length, pendingCount, records } };
});
