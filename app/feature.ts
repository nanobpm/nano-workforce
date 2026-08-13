// nano-workforce — single-issue feature run (issue #172).
//
// The "missing middle" dispatch surface, between Epics (plan-fanout: one issue →
// many PRs) and PR convergence (an already-open PR → review → merge): hand ONE
// issue to a single implementation agent (`senior:feature`), which raises exactly
// ONE PR, then OPTIONALLY hand that PR to the convergence loop (and, with
// auto-merge, the merge-loop).
//
// This module is the seam the `startFeature` action and the `feature.bpmn` record
// workers call: it owns the `feature_runs` row shape, the per-run task derivation,
// and starting the process. It deliberately REUSES the epic primitives rather than
// forking them — `parseIssue`/`renderBaseBranchBrief`/`normalizeBaseBranch` and the
// `ESCALATION_SLA_TIMEOUT` come from app/plan.ts, and the downstream PR lifecycle is
// the existing convergence loop (`submitPr`), keyed on `pr_key` → `pull_requests`.
// Data access goes through the record gateway (`data.table`), never hand-written
// SQL — matching app/plan.ts and app/service.ts.
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import { ESCALATION_SLA_TIMEOUT, normalizeBaseBranch, type ParsedIssue, renderBaseBranchBrief } from "./plan.ts";

/** The BPMN process this module drives (resources/processes/feature.bpmn). */
export const FEATURE_PROCESS_ID = "feature";

const now = () => new Date().toISOString();

/** One row per issue handed to a single implementation agent. Keyed on `feature_key`
 * (`<owner>/<repo>#<issue-number>`, the same string `parseIssue` returns as `planKey`).
 * The downstream PR lifecycle (review/merge) is NOT duplicated here — once `converge`
 * hands the opened PR to `submitPr`, its live state lives on the `pull_requests` row
 * keyed by `pr_key`. */
export interface FeatureRun {
  feature_key: string;
  repo: string;
  issue_number: number;
  issue_url: string;
  base_branch: string;
  status: FeatureRunStatus;
  process_key: string | null;
  pr_key: string | null;
  converge: number;
  auto_merge: number;
  outcome: string | null;
  /** Human rollup detail. Projected by `pollFeatureDelivery` (fix: Feature history stuck at
   * `converging`) and also written by `pr.record-blocked-ack` with the operator's disposition
   * note when a blocked run is acknowledged. NULL until there is a signal. The reconciled TERMINAL
   * outcome is written to `status` itself; this carries the sub-state / note (e.g. "merged",
   * "waiting_review", or "operator: <note>"). */
  delivery_label: string | null;
  /** The parked `feature-escalation` user task's `question`, denormalised by `pollFeatureEscalations`
   * so the pages can show what the agent asked. NULL whenever the run is not parked at an escalation
   * (cleared when it un-parks / resumes). */
  escalation_question: string | null;
  /** The completable native `feature-escalation` user-task key the answer affordance posts to
   * (`completeUserTaskAttributed`) and the pages gate the answer controls on (`showWhenField`). Set by
   * `pollFeatureEscalations` while parked; NULL otherwise. */
  escalation_user_task_key: string | null;
  created_at: string;
  updated_at: string;
}

export const FEATURE_RUN_STATUSES = [
  "running", // the agent is implementing
  "escalated", // NON-terminal: the run is parked at the `feature-escalation` operator user task,
  // waiting on a human answer (denormalised from the parked user task by pollFeatureEscalations)
  "opened", // a PR was raised and the run ends here (converge was not requested)
  "converging", // the opened PR was handed to the convergence loop (live state via pr_key → pull_requests)
  "awaiting_operator", // NON-terminal: the run is blocked and parked at the feature-blocked operator user task
  "merged", // reconciled: the handed-off PR MERGED (pollFeatureDelivery, from pull_requests.status)
  "converged", // reconciled: the handed-off PR converged but did not merge (auto-merge off)
  "blocked", // the agent could not open a PR (gave up / escalation abandoned)
  "skipped", // nothing to do
  "failed", // an unexpected failure
  "abandoned", // reconciled: the handed-off PR was abandoned (pollFeatureDelivery), or the process
  // instance itself was cancelled (set by instanceTracking.onTerminated)
] as const;
export type FeatureRunStatus = typeof FEATURE_RUN_STATUSES[number];

/** A feature run is finished once it leaves `running`. Mirrors PLAN_TERMINAL_STATUSES: a
 * re-dispatch of the same issue restarts only when the prior run has settled. `converging` stays
 * terminal-for-redispatch even though `pollFeatureDelivery` may later advance it to
 * `merged`/`converged`/`abandoned` — those are equally terminal, so redispatch gating is unaffected.
 * `awaiting_operator` is deliberately EXCLUDED (non-terminal): while a blocked run is parked at the
 * feature-blocked operator user task its instance is still alive, so a re-dispatch of the same issue
 * must short-circuit (no orphaned parallel instance) until the operator acknowledges it. `escalated`
 * is EXCLUDED for the same reason: a run parked at the `feature-escalation` user task is still alive,
 * so a re-dispatch must short-circuit until the human answers (or the SLA fires). */
export const FEATURE_TERMINAL_STATUSES: readonly FeatureRunStatus[] = [
  "opened",
  "converging",
  "merged",
  "converged",
  "blocked",
  "skipped",
  "failed",
  "abandoned",
];

/** Reconciled delivery outcome for a single feature run, derived from its handed-off PR's
 * `pull_requests.status`. Pure and read-only — the source of truth for the denormalised
 * `feature_runs.status` transition + `feature_runs.delivery_label` that `pollFeatureDelivery`
 * projects. Only meaningful for a run currently `converging` with a `pr_key`. */
export interface FeatureDeliveryRollup {
  /** The reconciled `feature_runs.status`. Stays `converging` while the PR is still in flight
   * (or its row is missing); advances to the matching terminal outcome once the PR settles. */
  status: FeatureRunStatus;
  /** Human rollup detail for the row (`delivery_label`). */
  label: string;
}

/** Map a handed-off PR's `pull_requests.status` to the feature run's reconciled outcome.
 *
 * - `merged` → `merged` (the win). `converged` → `converged` (review done, not merged — auto-merge
 *   was off). `abandoned` → `abandoned`.
 * - in-flight PR statuses (`converging`/`waiting_review`/`escalated`) keep the run `converging`,
 *   surfacing the live sub-state as the label so the grid stops looking frozen.
 * - `null` (the `pull_requests` row is missing — DB desync) keeps the run `converging` and labels
 *   it so the desync is visible, never a false-positive terminal. */
export function deriveFeatureDelivery(prStatus: string | null): FeatureDeliveryRollup {
  switch (prStatus) {
    case "merged":
      return { status: "merged", label: "merged" };
    case "converged":
      return { status: "converged", label: "converged (not merged)" };
    case "abandoned":
      return { status: "abandoned", label: "PR abandoned" };
    case null:
      return { status: "converging", label: "PR record missing" };
    default:
      return { status: "converging", label: prStatus };
  }
}

/** The `feature-escalation` user-task element id (feature.bpmn) — the native operator wait a run
 * parks on when the agent escalates. `pollFeatureEscalations` reconciles it onto the read model. */
export const FEATURE_ESCALATION_ELEMENT = "feature-escalation";

/** The parked `feature-escalation` user task, as `pollFeatureEscalations` observes it via
 * `searchUserTasks`: the completable user-task key the pages drive an attributed answer against.
 *
 * The agent's `question` is NOT read from here — the WASM testkit engine does not surface a user
 * task's `zeebe:ioMapping`-mapped local variables through `searchUserTasks`, so relying on it would
 * make the question untestable. Instead the `record-feature-escalation` service task (feature.bpmn)
 * persists `question` onto the row at escalation entry — see `workers/record-feature-escalation`. */
export interface FeatureEscalationParked {
  userTaskKey: string;
}

/** Pure source of truth for the escalation read-model reconcile (`pollFeatureEscalations`): given a
 * run and whether it is currently parked at `feature-escalation`, return the minimal `feature_runs`
 * patch reconciling the run's LIVENESS (status + completable-task pointer) with the observed park
 * state (or null when nothing changed, so the poller skips the write). Idempotent, and — crucially —
 * self-healing across the brief window between the `record-feature-escalation` service task and the
 * user task actually appearing: a premature "not parked" reset to `running` is re-flipped to
 * `escalated` on the next pass once the task is observed.
 *
 * - parked → flip `status` to `escalated` and denormalise the completable `userTaskKey` so the pages
 *   can drive an attributed answer. It never writes `escalation_question` — that is the service
 *   task's to own (set) and the exit paths' to clear (record-feature / the answer operation), so the
 *   poller can never clobber the persisted question during that self-healing window.
 * - un-parked → clear the completable-task pointer; a run still marked `escalated` has resumed
 *   (answered / looped back to implement-task), so it returns to `running`. A run already advanced
 *   past `escalated` by a downstream worker keeps that status — only the pointer is cleared. */
export function deriveFeatureEscalationPatch(
  run: Pick<FeatureRun, "status" | "escalation_user_task_key">,
  parked: FeatureEscalationParked | null,
): Partial<FeatureRun> | null {
  const patch: Partial<FeatureRun> = {};
  if (parked) {
    if (run.status !== "escalated") patch.status = "escalated";
    if (run.escalation_user_task_key !== parked.userTaskKey) patch.escalation_user_task_key = parked.userTaskKey;
  } else {
    if (run.status === "escalated") patch.status = "running";
    if (run.escalation_user_task_key !== null) patch.escalation_user_task_key = null;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

export const featureRuns = (data: DataLayer) => data.table<FeatureRun>("feature_runs", "feature_key");

/** The deterministic task id for a single-issue run — the implementation agent branches
 * `feat/<task.id>` (see prompts/feature.md), so it MUST be derivable from the issue alone
 * and stable across a resume. The PR is opened on the target repo, so the issue number
 * alone is unambiguous within it. */
export function featureTaskId(issueNumber: number): string {
  return `issue-${issueNumber}`;
}

/** Register/refresh the feature-run aggregate (idempotent on `feature_key`) and start
 * `feature.bpmn`. Mirrors startPlan: an already-running run for the same issue
 * short-circuits; a settled prior run is restarted in place. `baseBranch` is admitted at
 * the operation edge (`admitPlan`, ADR 0003) exactly as the epic path — this seam only
 * normalizes it again defensively before seeding the brief. */
export async function startFeature(
  data: DataLayer,
  engine: EngineClient,
  parsed: ParsedIssue,
  baseBranch: string,
  converge: boolean,
  autoMerge: boolean,
) {
  const table = featureRuns(data);
  const existing = await table.get(parsed.planKey);
  if (existing && !FEATURE_TERMINAL_STATUSES.includes(existing.status)) {
    return { featureKey: parsed.planKey, alreadyRunning: true, processKey: existing.process_key };
  }
  const base = normalizeBaseBranch(baseBranch);
  const ts = now();
  if (existing) {
    await table.update(parsed.planKey, {
      status: "running",
      base_branch: base,
      issue_url: parsed.url,
      pr_key: null,
      converge: converge ? 1 : 0,
      auto_merge: autoMerge ? 1 : 0,
      outcome: null,
      delivery_label: null,
      escalation_question: null,
      escalation_user_task_key: null,
      updated_at: ts,
    });
  } else {
    await table.insert({
      feature_key: parsed.planKey,
      repo: parsed.repo,
      issue_number: parsed.number,
      issue_url: parsed.url,
      base_branch: base,
      status: "running",
      process_key: null,
      pr_key: null,
      converge: converge ? 1 : 0,
      auto_merge: autoMerge ? 1 : 0,
      outcome: null,
      delivery_label: null,
      escalation_question: null,
      escalation_user_task_key: null,
      created_at: ts,
      updated_at: ts,
    });
  }
  const { processInstanceKey } = await engine.createInstance({
    processDefinitionId: FEATURE_PROCESS_ID,
    variables: {
      featureKey: parsed.planKey,
      repo: parsed.repo,
      // The parent issue reference (`owner/repo#123`) the agent reads for context (`gh issue view`).
      issue: parsed.planKey,
      issueNumber: parsed.number,
      issueUrl: parsed.url,
      // The single slice the implementation agent builds. `task.prompt` is its primary instruction
      // (prompts/feature.md); `task.id` fixes its deterministic branch `feat/<task.id>` across a
      // resume. Unlike an epic, there is no planner — the whole issue IS the slice.
      task: {
        id: featureTaskId(parsed.number),
        title: parsed.planKey,
        prompt:
          `Implement the GitHub issue ${parsed.planKey} end to end. Read it in full first ` +
          `(\`gh issue view ${parsed.number} -R ${parsed.repo}\`), implement it completely, ` +
          `and open exactly one pull request that closes it.`,
      },
      // Follow-on knobs, read by the record/converge workers. `autoMerge` maps to submitPr's
      // `convergeOnly` (inverted): converge-only stops at `converged`; auto-merge drives the
      // merge-loop. `converge=false` ⇒ merge is moot.
      converge,
      autoMerge,
      // A single-issue feature run OWNS its issue (the whole issue is the slice), so the agent may
      // claim it with a "starting work" comment on a first run (prompts/feature.md). Epic slices
      // (plan-fanout) deliberately DO NOT set this — their `issue` is the shared parent epic, which
      // must never be claimed per-slice.
      claimIssue: true,
      // Seed the agent-result variables so the escalation loop + record worker can reference them
      // before the first `senior:feature` job completes (the harness merges the real values in).
      answer: null,
      status: null,
      question: null,
      summary: null,
      pr: null,
      // Escalation SLA + optional assignee — identical to the epic path (plan-fanout), read by the
      // `feature-escalation` user task's interrupting timer boundary and assignment definition.
      escalationSlaTimeout: ESCALATION_SLA_TIMEOUT,
      escalationAssignee: null,
      // Base branch (ADR 0003): the branch the agent branches off and opens its PR against. The
      // brief rides `appendPrompt` in the implement task, exactly like the epic implementer.
      baseBranch: base,
      baseBranchBrief: renderBaseBranchBrief(base),
    },
  });
  const processKey = processInstanceKey == null ? null : String(processInstanceKey);
  if (processKey != null) {
    await table.update(parsed.planKey, { process_key: processKey, updated_at: now() });
  }
  return { featureKey: parsed.planKey, processKey };
}
