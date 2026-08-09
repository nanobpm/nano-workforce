// pr.record-results — the wave loop has finished; finalize the plan (issue #20).
//
// PR enrollment now happens per wave in `pr.record-wave` (so later waves can declare earlier
// waves' PRs as dependencies), leaving this worker as the terminal finalizer: it summarizes the
// plan from `plan_tasks` and marks it `done`. It reads no `results` — every task's outcome was
// already recorded by `record-wave` (opened / blocked) or `select-wave` (skipped).
import { BpmnError } from "@nanobpm/urban";
import type { AppJobHandler } from "@nanobpm/urban";
import { planTasks } from "../../app/plan.ts";

interface In extends Record<string, unknown> {
  planKey: string;
}

const handler: AppJobHandler<In> = async (job, app) => {
  const { planKey } = job.variables;
  const ts = new Date().toISOString();

  const rows = await planTasks(app.data).find({ plan_key: planKey });
  const opened = rows.filter((r) => r.status === "opened").length;

  // Categorical no-work guard (issue #86): the epic reached its finalizer having opened ZERO PRs —
  // an empty plan (e.g. the planner agent could not persist its result), or every task
  // blocked/skipped. It accomplished nothing, so it must NOT complete green and masquerade as
  // success. Record the outcome for observability, then raise a non-retryable BpmnError so the
  // engine parks the instance on an incident (no boundary catches `NO_WORK_DISPATCHED`) instead of
  // completing the process. This backstops any zero-work path regardless of the review outcome.
  if (opened === 0) {
    const outcome = rows.length === 0
      ? "no work dispatched — the planner produced no tasks"
      : "no work dispatched — every task was blocked or skipped";
    await app.data.table("plans", "plan_key").update(planKey, { outcome, updated_at: ts });
    app.log("error", `record-results: ${planKey} finalized with 0 opened PRs`, {
      taskCount: rows.length,
    });
    throw new BpmnError("NO_WORK_DISPATCHED", `${planKey}: ${outcome}`);
  }

  await app.data.table("plans", "plan_key").update(planKey, {
    status: "done",
    outcome: `${opened} PR(s) dispatched to convergence`,
    updated_at: ts,
  });

  return {};
};

export default handler;
