// pr.record-results — the wave loop has finished; finalize the plan (issue #20).
//
// PR enrollment now happens per wave in `pr.record-wave` (so later waves can declare earlier
// waves' PRs as dependencies), leaving this worker as the terminal finalizer: it summarizes the
// plan from `plan_tasks`. It reads no `results` — every task's outcome was already recorded by
// `record-wave` (opened / blocked) or `select-wave` (skipped).
//
// Two terminal outcomes:
//   • at least one PR opened → mark the plan `done` (dispatched to convergence).
//   • zero PRs opened → record a `failed` outcome for observability, then throw the non-retryable
//     `NO_WORK_DISPATCHED` BpmnError so the engine parks the instance on an incident instead of
//     completing green (issue #86). The `failed` status is terminal, so `startPlan` can re-plan it.

import type { AppJobHandler } from "@nanobpm/urban";
import { BpmnError } from "@nanobpm/urban";
import { plans, planTasks } from "../../app/plan.ts";

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
  // success. Record a `failed` terminal outcome for observability (so the DB state matches the
  // parked incident and `startPlan` can re-plan it — `dispatched`/`done` would otherwise block a
  // restart), then raise a non-retryable BpmnError so the engine parks the instance on an incident
  // (no boundary catches `NO_WORK_DISPATCHED`) instead of completing the process. This backstops
  // any zero-work path regardless of the review outcome.
  if (opened === 0) {
    const outcome = rows.length === 0
      ? "no work dispatched — the planner produced no tasks"
      : "no work dispatched — every task was blocked or skipped";
    await app.data.table("plans", "plan_key").update(planKey, {
      status: "failed",
      outcome,
      updated_at: ts,
    });
    app.log.error(`record-results: ${planKey} finalized with 0 opened PRs`, {
      taskCount: rows.length,
    });
    throw new BpmnError("NO_WORK_DISPATCHED", `${planKey}: ${outcome}`);
  }

  // Derive the epic "ready to promote" signal in its ONE canonical place (026_plan_promotion_pr_url,
  // #160): TRUE exactly when this plan is `done`, targets a pinned integration branch (`base_branch`
  // set), and has not been promoted yet (`promotion_pr_url` still NULL). We gate on the three stored
  // fields only — the repo-default-branch check is deferred to the promoteEpic operation, per #160.
  const plan = await plans(app.data).get(planKey);
  const promoteReady =
    plan != null && plan.base_branch != null && plan.promotion_pr_url == null ? 1 : 0;

  await app.data.table("plans", "plan_key").update(planKey, {
    status: "done",
    outcome: `${opened} PR(s) dispatched to convergence`,
    promote_ready: promoteReady,
    updated_at: ts,
  });

  return {};
};

export default handler;
