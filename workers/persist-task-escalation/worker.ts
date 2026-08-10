// pr.persist-task-escalation — an implementation agent escalated a task during the
// fan-out (issue #25). It reported `status = "escalated"` with a `question` and,
// ideally, a work-preserving DRAFT PR, then completed its job. This worker records
// that escalation and parks the plan on a per-task human answer:
//   • opens (or refreshes) a `plan_escalations` row (status = open),
//   • marks the `plan_tasks` row `escalated` with the question / draft PR / corr key,
//   • re-points the plan's denormalised "open task escalation" fields at the
//     oldest still-open escalation, so the page's single answer form surfaces it.
//
// The process then parks the child at the `feature-escalation-answered` message
// catch (correlationKey `<plan_key>:<task_id>`). Answering it (page form or
// `/hooks/feature-answer`) resumes the child, which re-dispatches the SAME task.
//
// Retry-safe: if an open escalation already exists for this corr key (a worker
// re-activation before the wait subscription opened), it is UPDATED, not
// duplicated — a fresh escalation row is only created after the previous one was
// answered.
import type { AppJobHandler } from "@nanobpm/urban";
import {
  featureCorrKey,
  planEscalations,
  planTasks,
  refreshOpenTaskEscalation,
} from "../../app/plan.ts";

interface TaskIn {
  id?: unknown;
  title?: unknown;
}
interface In extends Record<string, unknown> {
  planKey: string;
  task?: TaskIn;
  question?: unknown;
  pr?: unknown;
  summary?: unknown;
}
interface Out extends Record<string, unknown> {
  escalationId: number;
}

// A non-blank trimmed string, else undefined. A blank question/PR must not reach
// the UI answer form or masquerade as preserved work.
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const planKey = job.variables.planKey;
  const taskId = str(job.variables.task?.id);
  if (!taskId) {
    // No task binding means we cannot correlate a resume — fail loudly rather
    // than silently parking a token that can never be answered.
    throw new Error("persist-task-escalation: missing task.id in child scope");
  }
  const corrKey = featureCorrKey(planKey, taskId);
  const question = str(job.variables.question);
  if (!question) {
    // A blank question would surface a non-actionable placeholder in the answer
    // form and, on a retry, overwrite a previously recorded question. The output
    // contract requires `question` for an escalation — fail loudly, like the
    // missing-task.id guard above, rather than park an unanswerable escalation.
    throw new Error("persist-task-escalation: missing question for escalated task");
  }
  const draftPr = str(job.variables.pr) ?? null;
  // Prior-attempt context the escalating agent reported. Persist it so the UI
  // and any later resume/debugging keep the task's summary instead of NULL.
  const summary = str(job.variables.summary) ?? null;
  const ts = new Date().toISOString();

  const escTable = planEscalations(app.data);
  const existing = (await escTable.find({ corr_key: corrKey, status: "open" }))
    .sort((a, b) => b.id - a.id)[0];
  let escalationId: number;
  if (existing) {
    await escTable.update(existing.id, {
      question,
      draft_pr_key: draftPr ?? existing.draft_pr_key,
    });
    escalationId = existing.id;
  } else {
    escalationId = Number(
      await escTable.insert({
        plan_key: planKey,
        task_id: taskId,
        corr_key: corrKey,
        question,
        draft_pr_key: draftPr,
        status: "open",
        asked_at: ts,
      }),
    );
  }

  for (const t of await planTasks(app.data).find({ plan_key: planKey, task_id: taskId })) {
    await planTasks(app.data).update(t.id, {
      status: "escalated",
      open_question: question,
      // Clear any answer from a prior (already-answered) escalation so the task
      // row stays aligned with the currently-open question — otherwise a
      // re-escalated task would show a stale answer next to the new question.
      answer: null,
      draft_pr_key: draftPr ?? t.draft_pr_key,
      summary: summary ?? t.summary,
      corr_key: corrKey,
      updated_at: ts,
    });
  }

  await refreshOpenTaskEscalation(app.data, planKey);
  return { escalationId };
};

export default handler;
