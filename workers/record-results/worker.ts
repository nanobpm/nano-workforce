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
import { deriveEpicPhase } from "../../app/epicPhase.ts";
import { plans, planTasks } from "../../app/plan.ts";
import type { WorkerInputs } from "../../nano-generated/worker-io.d.ts";

// Input typed off the model data envelope (`RecordResultsIn` in plan-fanout.bpmn) — ADR 0040.
type In = WorkerInputs["pr.record-results"];

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
    await plans(app.data).update(planKey, {
      status: "failed",
      outcome,
      updated_at: ts,
    });
    app.log.error(`record-results: ${planKey} finalized with 0 opened PRs`, {
      taskCount: rows.length,
    });
    throw new BpmnError("NO_WORK_DISPATCHED", `${planKey}: ${outcome}`);
  }

  // Domain-phase projection (#261): the finalizer landed with opened PRs — the epic reaches its
  // terminal "Fleet dispatched" phase (derived structurally from this worker's BPMN element id).
  // The failed/no-work path above leaves epic_phase untouched: its terminal signal is status +
  // outcome, and stamping "Dispatched" against a failed epic would misread. A null derivation
  // (element id absent) must not clobber the last implementing phase.
  const epicPhase = deriveEpicPhase(job.elementId);
  await plans(app.data).update(planKey, {
    status: "done",
    outcome: `${opened} PR(s) dispatched to convergence`,
    ...(epicPhase ? { epic_phase: epicPhase } : {}),
    updated_at: ts,
  });

  return {};
};

export default handler;
