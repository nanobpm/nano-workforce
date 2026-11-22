// The epic-slice converge seam (issue #1007): enroll ONE plan-fanout slice's opened PR into the
// review-convergence loop from INSIDE the epic (the `converge-cell`'s plan-slice arm), exactly as a
// standalone `feature` run's converge step does — so an epic no longer parks at `wait-wave-merged`
// forever waiting on PRs nothing converges.
//
// This is the ONE place a slice PR is handed off (the old best-effort `record-wave` handoff was
// removed so there is no second enrollment path). It reuses the canonical `submitPr` — idempotent on
// the PR key, so an operator-started loop for the same PR is ADOPTED (`alreadyRunning`), never doubled.
//   • `dependsOn` = the PR keys of this slice's dependency tasks (earlier waves, already recorded on
//     `plan_tasks.pr_key` by `record-wave`), so the merge-ordering DAG matches the task DAG.
//   • `rootRequestKey` = the plan key, so the loop's review rounds/escalations/merge roll up under
//     the epic in `/status` and its escalations route through the epic's path.
//   • `autoResolveEscalations` = the plan row's durable steward opt-in (issue #889).
//   • `autoMerge` = the epic's merge policy (default true: merge into the epic base branch), seeded at
//     `start/plan-fanout`.
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import { plans, planTaskDeps, planTasks } from "./plan.ts";
import { type ParsedPr, parsePr } from "./prParse.ts";

export interface ConvergeSliceInput {
  planKey: unknown;
  taskId: unknown;
  prKey: unknown;
  autoMerge?: unknown;
}

export interface ConvergeSliceOutcome {
  enrolled: boolean;
  prKey: string | null;
  dependsOn: string[];
  autoMerge: boolean;
  autoResolveEscalations: boolean;
}

/** The injected enrollment — the canonical `submitPr` in production (positional, mirrors its
 *  signature for the arguments this seam sets). */
export type SliceSubmit = (
  parsed: ParsedPr,
  dependsOn: string[],
  rootRequestKey: string,
  autoResolveEscalations: boolean,
  autoMerge: boolean,
) => Promise<unknown>;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;

/** The epic's merge intent: an explicit boolean `false` opts out (converge only); anything else
 *  (absent / null — an epic started before the policy was seeded) keeps the default auto-merge. */
export function sliceMergeIntent(autoMerge: unknown): boolean {
  return autoMerge !== false;
}

export async function convergeSlice(
  data: DataLayer,
  input: ConvergeSliceInput,
  submit: SliceSubmit,
): Promise<ConvergeSliceOutcome> {
  const planKey = str(input.planKey);
  const taskId = str(input.taskId);
  const parsed = parsePr(str(input.prKey));
  if (!planKey || !parsed) {
    // The wave body only routes here for an `opened` slice WITH a PR key, but never enroll a phantom.
    return { enrolled: false, prKey: null, dependsOn: [], autoMerge: sliceMergeIntent(input.autoMerge), autoResolveEscalations: false };
  }
  const planRow = await plans(data).get(planKey);
  // Merge policy (issue #1007 review): read the OPERATOR's intent from the durable `plans.auto_merge`
  // column — NEVER from the `autoMerge` process variable, which an agent completion can clobber. The
  // row is authoritative so an operator's explicit `false` opt-out survives any agent output. A
  // missing row (or a pre-#1007 row, whose column DEFAULTs to 1) falls back to the input's intent.
  const autoMerge = planRow != null ? planRow.auto_merge !== 0 : sliceMergeIntent(input.autoMerge);
  const dependsOn: string[] = [];
  if (taskId) {
    const depIds = (await planTaskDeps(data).find({ plan_key: planKey, task_id: taskId }))
      .map((d) => d.depends_on_task_id);
    if (depIds.length > 0) {
      const rows = await planTasks(data).find({ plan_key: planKey });
      for (const depId of depIds) {
        const key = rows.find((r) => r.task_id === depId)?.pr_key;
        if (key) dependsOn.push(key);
      }
    }
  }
  const autoResolveEscalations = planRow?.auto_resolve_escalations === 1;
  await submit(parsed, dependsOn, planKey, autoResolveEscalations, autoMerge);
  return { enrolled: true, prKey: parsed.prKey, dependsOn, autoMerge, autoResolveEscalations };
}

/** Adapt the canonical `submitPr` to the {@link SliceSubmit} seam. */
export function submitPrAsSliceSubmit(
  data: DataLayer,
  engine: EngineClient,
  submitPr: (
    data: DataLayer,
    engine: EngineClient,
    parsed: ParsedPr,
    dependsOn: string[],
    maxRounds: number,
    convergeOnly: boolean,
    rootRequestKey: string | null,
    humanApproval: boolean,
    autoResolveEscalations: boolean,
    autoMerge?: boolean,
  ) => Promise<unknown>,
  maxRounds: number,
): SliceSubmit {
  return (parsed, dependsOn, rootRequestKey, autoResolve, autoMerge) =>
    submitPr(data, engine, parsed, dependsOn, maxRounds, !autoMerge, rootRequestKey, false, autoResolve, autoMerge);
}
