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
import { coalesceTitle, fetchIssueTitle } from "./github.ts";
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
  /** Human-readable identity (the GitHub issue title) for the feature grids (issue #248). Fetched
   * best-effort at `startFeature` and coalesced to the `owner/repo#N` key at write time, so it is
   * ALWAYS non-blank — the grid's `{{title}}` template needs no fallback and a failed/absent title
   * fetch still shows a usable identity (the key) rather than an empty cell. */
  title: string | null;
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
  /** The parked `feature-escalation` user task's `question`, persisted at escalation entry by the
   * `record-feature-escalation` worker (NOT by `pollFeatureEscalations` while parked, which
   * deliberately never writes it) so the pages can show what the agent asked. NULL whenever the run
   * is not parked at an escalation — cleared on the exit paths (`record-feature` / the answer
   * operation), and, as a self-heal, by `pollFeatureEscalations` when a previously-observed task is
   * completed out-of-band (see `deriveFeatureEscalationPatch`). */
  escalation_question: string | null;
  /** The completable native `feature-escalation` user-task key the answer affordance posts to
   * (`completeUserTaskAttributed`) and the pages gate the answer controls on (`showWhenField`). Set by
   * `pollFeatureEscalations` while parked; NULL otherwise. */
  escalation_user_task_key: string | null;
  /** The completable native `feature-blocked` user-task key the "Acknowledge blocked" affordance posts
   * to (`completeUserTaskAttributed`) and the pages gate the acknowledge control on (`showWhenField`).
   * Kept DISTINCT from `escalation_user_task_key` so the two human tasks (an escalation answer vs a
   * blocked-run acknowledgement) are never conflated. Set by `pollFeatureBlocked` while a run is parked
   * at `feature-blocked` (status `awaiting_operator`); NULL otherwise — cleared on the exit paths
   * (`record-blocked-ack` / the acknowledge operation) and, as a self-heal, by `pollFeatureBlocked`
   * when a previously-observed task is completed out-of-band (see `deriveFeatureBlockedPatch`). */
  blocked_user_task_key: string | null;
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
 *   can drive an attributed answer. It never writes `escalation_question` while parked — that is the
 *   service task's to own (set) and the exit paths' to clear (record-feature / the answer operation),
 *   so the poller can never clobber the persisted question during that self-healing window.
 * - un-parked → clear the completable-task pointer; a run still marked `escalated` has resumed
 *   (answered / looped back to implement-task), so it returns to `running`. A run already advanced
 *   past `escalated` by a downstream worker keeps that status — only the pointer is cleared. Once the
 *   pointer was actually OBSERVED (non-NULL) and the task is now gone, `escalation_question` is also
 *   cleared here, self-healing a question left populated when the task was completed out-of-band
 *   (bypassing the answer operation). This is gated on the observed pointer precisely so it cannot
 *   fire in the pre-observation self-healing window, where the pointer is still NULL. */
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
    // Un-park cleanup — fires ONLY once the poller has actually OBSERVED the task (pointer non-NULL)
    // and it is now gone. This self-heals a `question` left populated when the task was completed
    // out-of-band (e.g. an external task UI, bypassing the answer operation that normally clears it),
    // which would otherwise keep the UI showing an Escalation on a run that has resumed. Gating on
    // the pointer being non-NULL is what makes it safe: during the brief self-healing window between
    // `record-feature-escalation` (which persists the question but leaves the pointer NULL) and the
    // task appearing, the pointer is NULL, so this never clobbers the freshly-persisted question.
    if (run.escalation_user_task_key !== null) {
      patch.escalation_user_task_key = null;
      patch.escalation_question = null;
    }
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** The `feature-blocked` user-task element id (feature.bpmn) — the native operator wait a run parks on
 * when the agent reports a `blocked` outcome (it gave up / the escalation was abandoned or timed out).
 * `pollFeatureBlocked` reconciles it onto the read model. */
export const FEATURE_BLOCKED_ELEMENT = "feature-blocked";

/** The parked `feature-blocked` user task, as `pollFeatureBlocked` observes it via `searchUserTasks`:
 * the completable user-task key the pages drive an attributed acknowledgement against. */
export interface FeatureBlockedParked {
  userTaskKey: string;
}

/** Pure source of truth for the blocked read-model reconcile (`pollFeatureBlocked`), the blocked twin
 * of `deriveFeatureEscalationPatch`: given a run and whether it is currently parked at `feature-blocked`,
 * return the minimal `feature_runs` patch reconciling the completable-task pointer with the observed park
 * state (or null when nothing changed, so the poller skips the write). Idempotent and self-healing.
 *
 * Unlike the escalation reconcile, the STATUS flip is NOT owned here: `record-feature` already persists
 * the row as `awaiting_operator` in the same token path before the `feature-blocked` user task is
 * created, and `record-blocked-ack` settles it to the terminal `blocked` on completion. So this only
 * reconciles the completable-task POINTER — never the status — so it can never overwrite the terminal
 * `blocked` the acknowledgement worker has already written.
 *
 * - parked → denormalise the completable `userTaskKey` so the pages can drive an attributed acknowledge.
 * - un-parked → clear the pointer ONLY once it was actually OBSERVED (non-NULL) and the task is now gone.
 *   Gating on the observed pointer is what makes it safe across the brief self-healing window between
 *   `record-feature` (which persists `awaiting_operator` but leaves the pointer NULL) and the user task
 *   appearing: in that window the pointer is NULL, so this never fires, and the next pass fills it in once
 *   the task is observable. Once observed and then gone (e.g. an out-of-band completion), the stale
 *   pointer is cleared so the pages stop offering an acknowledge control for a task that no longer exists. */
export function deriveFeatureBlockedPatch(
  run: Pick<FeatureRun, "blocked_user_task_key">,
  parked: FeatureBlockedParked | null,
): Partial<FeatureRun> | null {
  const patch: Partial<FeatureRun> = {};
  if (parked) {
    if (run.blocked_user_task_key !== parked.userTaskKey) patch.blocked_user_task_key = parked.userTaskKey;
  } else {
    // Un-park cleanup — fires ONLY once the poller has actually OBSERVED the task (pointer non-NULL) and
    // it is now gone. Gating on the pointer being non-NULL is what makes it safe: during the brief
    // self-healing window between `record-feature` (which persists `awaiting_operator` but leaves the
    // pointer NULL) and the task appearing, the pointer is NULL, so this never clears prematurely.
    if (run.blocked_user_task_key !== null) patch.blocked_user_task_key = null;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

export const featureRuns = (data: DataLayer) => data.table<FeatureRun>("feature_runs", "feature_key");

/** The deterministic task id for a single-issue run — the implementation agent branches
 * `feat/<task.id>` (see resources/prompts/feature.md), so it MUST be derivable from the issue alone
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
  customInstructions: string | null = null,
) {
  // Operator free-text steering for the implementation agent (issue #172 follow-on): blank/absent →
  // null so the implement task's `appendPrompt` FEEL (`customInstructions = null`) skips the block
  // rather than appending an empty "Operator custom instructions" heading.
  const instructions = typeof customInstructions === "string" && customInstructions.trim() !== ""
    ? customInstructions.trim()
    : null;
  const table = featureRuns(data);
  const existing = await table.get(parsed.planKey);
  if (existing && !FEATURE_TERMINAL_STATUSES.includes(existing.status)) {
    return { featureKey: parsed.planKey, alreadyRunning: true, processKey: existing.process_key };
  }
  const base = normalizeBaseBranch(baseBranch);
  const ts = now();
  // Human-readable identity for the feature grids (issue #248): fetch the issue title best-effort
  // and coalesce to the `owner/repo#N` key so `feature_runs.title` is ALWAYS non-blank (see the
  // interface note); a blank/whitespace fetch counts as missing. A fetch failure never blocks the
  // start (`fetchIssueTitle` returns null on any error).
  const title = coalesceTitle(
    await fetchIssueTitle(parsed.repo, parsed.number, process.env.GITHUB_TOKEN ?? ""),
    parsed.planKey,
  );
  if (existing) {
    await table.update(parsed.planKey, {
      status: "running",
      base_branch: base,
      issue_url: parsed.url,
      title,
      pr_key: null,
      converge: converge ? 1 : 0,
      auto_merge: autoMerge ? 1 : 0,
      outcome: null,
      delivery_label: null,
      escalation_question: null,
      escalation_user_task_key: null,
      blocked_user_task_key: null,
      updated_at: ts,
    });
  } else {
    await table.insert({
      feature_key: parsed.planKey,
      repo: parsed.repo,
      issue_number: parsed.number,
      issue_url: parsed.url,
      title,
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
      blocked_user_task_key: null,
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
      // (resources/prompts/feature.md); `task.id` fixes its deterministic branch `feat/<task.id>` across a
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
      // claim it with a "starting work" comment on a first run (resources/prompts/feature.md). Epic slices
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
      // Optional operator steering, appended to the implement agent's prompt via the implement
      // task's `appendPrompt` FEEL (feature.bpmn). Null when none was supplied; persists on the
      // instance so it also rides the answer-loop redispatch back into the same implement task.
      customInstructions: instructions,
    },
  });
  const processKey = processInstanceKey == null ? null : String(processInstanceKey);
  if (processKey != null) {
    await table.update(parsed.planKey, { process_key: processKey, updated_at: now() });
  }
  return { featureKey: parsed.planKey, processKey };
}
