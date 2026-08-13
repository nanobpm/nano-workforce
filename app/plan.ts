// nano-workforce — planning fan-out logic (issue #14).
//
// A planning agent (`senior:plan`) decomposes an issue into a list of tasks; the
// `plan-fanout` process then fans those tasks out over a parallel multi-instance
// service task (`senior:feature`), one implementation agent per task. Each agent
// opens a PR, which `record-results` enrolls into the existing convergence loop.
//
// This module is the seam the start actions and the record workers call: it owns
// issue parsing, the plan/plan_tasks row shapes, the prompt assets, and starting
// the process. Data access goes through the record gateway (`data.table`), never
// hand-written SQL — matching app/service.ts.
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import { completeUserTaskAttributed } from "./agentCompletion.ts";
import { blackboardUrl, mintBlackboardToken, renderCoordinationBrief } from "./blackboard.ts";
import { DEFAULT_ESCALATION_SLA_TIMEOUT, escalationSlaTimeout } from "./escalationSla.ts";
import { clearExclusions } from "./mergeExclusion.ts";
import { clearTaskDeltas } from "./taskDelta.ts";

/** The BPMN process this module drives (resources/processes/plan-fanout.bpmn). */
export const PLAN_PROCESS_ID = "plan-fanout";

/** The fleet-wide escalation SLA (ISO-8601 duration) seeded onto every plan-fanout instance as the
 * `escalationSlaTimeout` process variable and evaluated by each escalation user task's interrupting
 * timer boundary. An operator sets `NANO_ESCALATION_SLA_TIMEOUT`; a malformed value falls back to
 * {@link DEFAULT_ESCALATION_SLA_TIMEOUT} so a bad env can never deploy an uninterpretable timer. */
export const ESCALATION_SLA_TIMEOUT = escalationSlaTimeout(
  process.env.NANO_ESCALATION_SLA_TIMEOUT,
  DEFAULT_ESCALATION_SLA_TIMEOUT,
);

const now = () => new Date().toISOString();

// Agent prompts are no longer read by the host. The `senior:plan`, `senior:plan-review`, and
// `senior:feature` prompts are authored in the model as `{{plan}}` / `{{plan-review}}` /
// `{{feature}}` deploy-time templates (see `models.templates` in nano.app.json) substituted into
// each task's `io.nanobpm.agentTask.task.prompt` header. Per-instance dynamic context (a plan's
// rejection findings, a task's brief) rides `appendPrompt`, which the harness concatenates onto
// the header base. The host only carries runtime identity + `planFindings`.

export interface Plan {
  plan_key: string;
  repo: string;
  issue_number: number;
  issue_url: string;
  title: string | null;
  status: string;
  task_count: number;
  process_key: string | null;
  outcome: string | null;
  // Denormalised "oldest open task escalation" pointer (issue #25): the plans page
  // detail has a single answer form per row, so the oldest still-open per-task
  // escalation is surfaced here; answering re-points these at the next one (or
  // clears them). See refreshOpenTaskEscalation.
  open_task_escalation_id: number | null;
  open_task_question: string | null;
  open_task_corr_key: string | null;
  open_task_id: string | null;
  // Denormalised "open plan-review escalation" pointer (# plan-review escalation): when the
  // adversarial plan-review cap is reached without approval, the process parks for a human
  // proceed/revise directive. These fields surface the newest open plan-level escalation on the
  // plans page without overloading the implementation-phase `plan_escalations` table.
  open_plan_escalation_id: number | null;
  open_plan_findings: string | null;
  open_plan_round: number | null;
  // Wave-merge barrier (007_wave_gate.sql): the wave index whose PRs the plan is currently
  // waiting to see MERGED before dispatching the next wave, or null when not parked at the barrier.
  gate_wave: number | null;
  // Operator-visibility wave progress (022_plan_wave_progress.sql, #137): denormalised so the
  // epics-index can show wave X/N at a glance. `wave_count` is the total waves (N); `current_wave`
  // is the 0-based index of the wave the fleet is actively implementing (advanced by select-wave,
  // pinned to wave_count-1 on completion). Display-only — never gates control flow. NULL until the
  // plan is dispatched with tasks.
  wave_count: number | null;
  current_wave: number | null;
  // Pre-formatted 1-based "X/N" progress string for the epics-index at-a-glance column
  // (022_plan_wave_progress.sql, #137). The dataGrid has no per-cell templating (nano-ide#214),
  // so this is projected alongside the numeric columns by the same worker writes. NULL until
  // dispatched with tasks.
  wave_label: string | null;
  // Per-plan capability token for the coordination blackboard (009_plan_blackboard.sql, #51).
  // Minted at plan start; baked into the blackboard URL handed to implementer agents. NULL for
  // plans created before the blackboard shipped.
  blackboard_token: string | null;
  // Optional target base branch (019_plan_base_branch.sql): when set, the fleet branches off this
  // branch and opens every task PR against it instead of the repository's default branch, landing
  // the whole epic on a long-lived integration branch. NULL keeps the default-branch behaviour.
  base_branch: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlanTask {
  id: number;
  plan_key: string;
  task_index: number;
  task_id: string;
  title: string | null;
  prompt: string | null;
  status: PlanTaskStatus;
  pr_key: string | null;
  summary: string | null;
  wave: number | null;
  // Implementation-phase escalation (issue #25): the agent's open question, the
  // human's answer, the work-preserving draft PR, and the message correlation key
  // (`<plan_key>:<task_id>`) the process parks on. NULL unless the task escalated.
  open_question: string | null;
  answer: string | null;
  draft_pr_key: string | null;
  corr_key: string | null;
  created_at: string;
  updated_at: string;
}

export const PLAN_TASK_STATUSES = [
  "pending",
  "opened",
  "blocked",
  "skipped",
  "escalated",
  "waiting-for-lane",
] as const;
export type PlanTaskStatus = typeof PLAN_TASK_STATUSES[number];

/** One implementation-phase escalation (issue #25) — the per-task analogue of the
 * review loop's `escalations` row. `status` is open | answered. */
export interface PlanEscalation {
  id: number;
  plan_key: string;
  task_id: string;
  corr_key: string;
  question: string;
  answer: string | null;
  draft_pr_key: string | null;
  status: string;
  asked_at: string;
  answered_at: string | null;
}

export const plans = (data: DataLayer) => data.table<Plan>("plans", "plan_key");
export const planTasks = (data: DataLayer) => data.table<PlanTask>("plan_tasks", "id");
export const planEscalations = (data: DataLayer) =>
  data.table<PlanEscalation>("plan_escalations", "id");

/** The out-of-band webhook discriminator that resumes an escalated task. The process now parks on
 * the native `feature-escalation` user task (see plan-fanout.bpmn); answering completes that task
 * rather than publishing a message. Kept as the public route key for `POST /actions/message`. */
export const FEATURE_ESCALATION_MESSAGE = "feature-escalation-answered";

/** The out-of-band webhook discriminator that resumes a plan-review escalation. The process now
 * parks on the native `plan-review-decision` user task; answering completes that task. Kept as the
 * public route key for `POST /actions/message`. */
export const PLAN_ESCALATION_MESSAGE = "plan-escalation-answered";

/** The `elementId` of the native user task each escalation parks on (see plan-fanout.bpmn). The
 * answer paths locate the parked task by these ids via `searchUserTasks`. */
export const FEATURE_ESCALATION_TASK = "feature-escalation";
export const PLAN_REVIEW_DECISION_TASK = "plan-review-decision";

/** Build the per-task message correlation key the process parks on. */
export const featureCorrKey = (planKey: string, taskId: string) => `${planKey}:${taskId}`;

/** One dependency edge in the plan DAG (issue #20): `task_id` waits for `depends_on_task_id`.
 * Keyed on `plan_key` so a single delete clears a plan's whole edge set (as pr_dependencies). */
export interface PlanTaskDep {
  plan_key: string;
  task_id: string;
  depends_on_task_id: string;
}
export const planTaskDeps = (data: DataLayer) =>
  data.table<PlanTaskDep>("plan_task_deps", "plan_key");

/** One adversarial plan-review round (006_plan_review.sql): the `senior:plan-review` agent's
 * verdict on the plan before fan-out. Append-only within a plan run; the current round is
 * `count(plan_reviews)`. Re-planning a finished issue clears the prior rows (see startPlan) so
 * the round index restarts at 0.
 * `job_key` is the engine job key that wrote the row — an idempotency guard so a retried job
 * (crash/timeout after the insert) reuses its row instead of appending a duplicate round. */
export interface PlanReview {
  plan_key: string;
  epoch: number;
  round: number;
  approved: number;
  findings: string | null;
  created_at: string;
  job_key: string | null;
}
export const planReviews = (data: DataLayer) => data.table<PlanReview>("plan_reviews", "plan_key");

export type PlanEscalationDirective = "proceed" | "revise";

/** Narrow an arbitrary directive input to the typed set, defaulting to `revise` (the safe,
 * re-planning outcome) for anything unexpected. */
export function normalizePlanEscalationDirective(input: unknown): PlanEscalationDirective {
  const norm = typeof input === "string" ? input.trim().toLowerCase() : input;
  return norm === "proceed" ? "proceed" : "revise";
}

/** One plan-review cap escalation. Kept in a dedicated table rather than overloading
 * `plan_escalations`: the latter is task-scoped (`task_id`/`corr_key` are NOT NULL and mirrored
 * onto `plan_tasks`), while this row is plan-scoped and drives the review epoch reset. */
export interface PlanReviewEscalation {
  id: number;
  plan_key: string;
  epoch: number;
  round: number;
  findings: string | null;
  status: string;
  directive: PlanEscalationDirective | null;
  note: string | null;
  asked_at: string;
  answered_at: string | null;
}
export const planReviewEscalations = (data: DataLayer) =>
  data.table<PlanReviewEscalation>("plan_review_escalations", "id");

/** Read a positive-integer env override, falling back when unset/blank/invalid. A bad value
 * (e.g. "", "abc", "0", "2.5") must NOT silently become `NaN`/`0` — that would make the round
 * cap `round + 1 >= cap` always false and allow an unbounded revise loop. */
export function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Max adversarial plan-review rounds per epoch. Reaching the cap WITHOUT approval parks the
 * fan-out on a human plan-review escalation rather than dispatching an un-approved plan (issue
 * #86). A human `revise` answer starts a fresh epoch, so the next plan gets a full new budget. */
export const MAX_PLAN_REVIEW_ROUNDS = positiveIntEnv("NANO_PLAN_REVIEW_ROUNDS", 3);

/** The current review epoch is a durable process variable (`planReviewEpoch`) bumped by the
 * `plan-review-decision` user task each time a human answers a plan-review escalation. It is read
 * back by `record-plan-review` to reset the round budget — there is no derived counter here. */

/** A plan is "done" in exactly these states; everything else (planning, dispatched)
 * is in flight. The cancel guard and the active view key off this. */
export const PLAN_TERMINAL_STATUSES: readonly string[] = ["done", "failed", "abandoned"];

export interface ParsedIssue {
  repo: string;
  number: number;
  url: string;
  planKey: string;
}

/** Parse "owner/repo#123" or a canonical issue URL into its parts. Mirrors parsePr
 * (app/service.ts) but for the /issues/ path. */
export function parseIssue(input: string): ParsedIssue | null {
  const s = input.trim();
  let m = s.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i);
  if (m) {
    const repo = `${m[1]}/${m[2]}`;
    const number = Number(m[3]);
    return { repo, number, url: `https://github.com/${repo}/issues/${number}`, planKey: `${repo}#${number}` };
  }
  m = s.match(/^([^/]+\/[^#]+)#(\d+)$/);
  if (m) {
    const repo = m[1];
    const number = Number(m[2]);
    return { repo, number, url: `https://github.com/${repo}/issues/${number}`, planKey: `${repo}#${number}` };
  }
  return null;
}

/** Raised when a caller supplies a `baseBranch` that isn't a plausible git branch name. The
 * value is interpolated into the authoritative implementer prompt (which carries `git`/`gh`
 * shell snippets and inline-code Markdown), so a non-ref value could break the rendered
 * instructions or smuggle in a command/prompt fragment — reject it at the edge instead. */
export class InvalidBaseBranchError extends Error {
  readonly value: string;
  constructor(value: string) {
    super(`invalid base branch name: ${JSON.stringify(value)}`);
    this.name = "InvalidBaseBranchError";
    this.value = value;
  }
}

/** Conservative allowlist gate for a base-branch name. Stricter than `git check-ref-format` on
 * purpose: only `[A-Za-z0-9._/-]`, no leading `/`/`.`/`-` (a leading dash reads as a CLI flag),
 * no trailing `/`/`.`, no `..`/`//`, no empty or `.lock`-suffixed path component, bounded length.
 * This rejects whitespace, shell metacharacters, command substitution, and newlines outright. */
function isPlausibleBranchName(s: string): boolean {
  if (s.length === 0 || s.length > 255) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(s)) return false;
  if (/^[/.-]/.test(s) || /[/.]$/.test(s)) return false;
  if (s.includes("..") || s.includes("//")) return false;
  return s.split("/").every((seg) => seg.length > 0 && !seg.startsWith(".") && !seg.endsWith(".lock"));
}

/** Normalise a caller-supplied base branch: trim, and treat blank as "unset" (null) so the fleet
 * falls back to the repository's default branch — the legacy behaviour. A non-blank value that is
 * not a plausible git branch name is rejected (`InvalidBaseBranchError`) rather than persisted or
 * rendered into the agent prompt; the operation edge maps that to a 400. */
export function normalizeBaseBranch(input: string | null | undefined): string | null {
  const s = (input ?? "").trim();
  if (s.length === 0) return null;
  if (!isPlausibleBranchName(s)) throw new InvalidBaseBranchError(s);
  return s;
}

/** The per-instance brief appended to an implementer agent's prompt when the plan pins a base
 * branch. It is authoritative over the static "branch off the default branch" wording in
 * prompts/feature.md, so the agent branches off — and opens its PR against — the integration
 * branch, and reads the epic's latest landed state there rather than the repo default branch. */
export function renderBaseBranchBrief(baseBranch: string): string {
  return [
    "",
    "",
    "---",
    "",
    `**Base branch (authoritative — overrides any "default branch" instruction above): \`${baseBranch}\`.**`,
    "",
    `This epic lands on \`${baseBranch}\`, NOT the repository default branch. Everywhere the`,
    "instructions say \"default branch\", use this branch instead:",
    "",
    `- Branch off it: \`git fetch origin ${baseBranch} && git checkout -b feat/<task.id> origin/${baseBranch}\`.`,
    `- Read the epic's latest landed state from \`${baseBranch}\` (your prerequisites merged there, not into the default branch).`,
    `- Open your PR against it: \`gh pr create --base ${baseBranch} ...\`.`,
    "",
    "Do not target the repository default branch — a PR opened against it will not be merged into the epic.",
  ].join("\n");
}

/** Register a plan row (if new) and start the plan-fanout process. Idempotent on
 * planKey: a plan already in flight is not restarted. */
export async function startPlan(
  data: DataLayer,
  engine: EngineClient,
  parsed: ParsedIssue,
  baseBranch: string | null = null,
) {
  const table = plans(data);
  const existing = await table.get(parsed.planKey);
  if (existing && !PLAN_TERMINAL_STATUSES.includes(existing.status)) {
    return { planKey: parsed.planKey, alreadyRunning: true };
  }
  const base = normalizeBaseBranch(baseBranch);
  const ts = now();
  // Mint (or reuse, on a re-plan) this plan's blackboard capability token, and render the
  // coordination brief that carries its concrete URL. The token is the credential; agents reach
  // the blackboard directly with the URL we seed into `appendPrompt` below (#51).
  const token = existing?.blackboard_token ?? mintBlackboardToken();
  const bbUrl = blackboardUrl(token);
  if (existing) {
    // Re-plan a previously finished issue: clear the old tasks and start fresh.
    for (const t of await planTasks(data).find({ plan_key: parsed.planKey })) {
      await planTasks(data).delete(t.id);
    }
    // `plan_reviews` is append-only and the review round is derived from
    // `count(plan_reviews)`, so stale rows from the prior run would inflate the
    // next round index and reach the review-round cap early (bypassing the gate).
    // Clear them here — the table is keyed on `plan_key`, so one delete drops the
    // whole set (mirrors how record-plan clears `plan_task_deps`).
    await planReviews(data).delete(parsed.planKey);
    // Same for the structured impl-change deltas (D5, #55): keyed on `id`, so drop the prior run's
    // rows one-by-one, otherwise a stale delta lingers in the epic report for a task we just deleted.
    await clearTaskDeltas(data, parsed.planKey);
    // And the merge-exclusion graph (D1, #57): stale edges would mislead the merge-train.
    await clearExclusions(data, parsed.planKey);
    await table.update(parsed.planKey, {
      status: "planning",
      task_count: 0,
      issue_url: parsed.url,
      outcome: null,
      // Reset the denormalised "surfaced escalation" pointer so nothing from the
      // prior run lingers on the plan row (would otherwise show a dead answer form).
      open_task_escalation_id: null,
      open_task_question: null,
      open_task_corr_key: null,
      open_task_id: null,
      open_plan_escalation_id: null,
      open_plan_findings: null,
      open_plan_round: null,
      blackboard_token: token,
      base_branch: base,
      updated_at: ts,
    });
  } else {
    await table.insert({
      plan_key: parsed.planKey,
      repo: parsed.repo,
      issue_number: parsed.number,
      issue_url: parsed.url,
      status: "planning",
      task_count: 0,
      blackboard_token: token,
      base_branch: base,
      created_at: ts,
      updated_at: ts,
    });
  }
  const { processInstanceKey } = await engine.createInstance({
    processDefinitionId: PLAN_PROCESS_ID,
    variables: {
      planKey: parsed.planKey,
      repo: parsed.repo,
      issue: parsed.planKey,
      issueNumber: parsed.number,
      issueUrl: parsed.url,
      planFindings: null,
      // The plan-review epoch is a durable process variable, bumped by the `plan-review-decision`
      // user task each time a human answers a plan-review escalation. `record-plan-review` reads it
      // to reset the per-epoch round budget; it starts at 0 for the first review round.
      planReviewEpoch: 0,
      // Escalation-of-the-escalation SLA (U5, #156): the validated ISO-8601 duration seeded onto the
      // instance and read by each escalation user task's interrupting timer boundary
      // (`<bpmn:timeDuration>=escalationSlaTimeout`). If a human never answers, the boundary fires and
      // the process auto-proceeds down the gateway's safe-default arm — durable in-process liveness,
      // not a poller-side watchdog. `escalationAssignee` is the optional named assignee the escalation
      // user tasks' `zeebe:assignmentDefinition` resolves (null = unassigned, routed via the
      // `operators` candidate group); an operator/agent can claim/reassign via the task inbox.
      escalationSlaTimeout: ESCALATION_SLA_TIMEOUT,
      escalationAssignee: null,
      // Coordination blackboard (#51): the capability URL + the protocol brief that each
      // implementer agent gets appended to its prompt (composed into `appendPrompt` in
      // plan-fanout.bpmn's implement-task). Advisory shared state, delivered in-band, used
      // out-of-band.
      blackboardUrl: bbUrl,
      blackboardBrief: renderCoordinationBrief(bbUrl),
      // Optional epic base branch (019_plan_base_branch.sql): the branch the fleet branches off and
      // opens every PR against instead of the repo default. `baseBranchBrief` rides `appendPrompt`
      // in the implement-task (like `blackboardBrief`); both are null when no base branch is pinned,
      // so the agent keeps the default-branch behaviour from prompts/feature.md.
      baseBranch: base,
      baseBranchBrief: base == null ? null : renderBaseBranchBrief(base),
    },
  });
  const processKey = processInstanceKey == null ? null : String(processInstanceKey);
  if (processKey != null) {
    await table.update(parsed.planKey, { process_key: processKey, updated_at: now() });
  }
  return { planKey: parsed.planKey, processKey };
}

/** Read the per-instance `task.id` a `feature-escalation` user task carries, so an answer can be
 * routed to the exact parked child in a multi-instance fan-out. */
function userTaskTaskId(variables: Record<string, unknown> | undefined): string | undefined {
  const task = variables?.task;
  if (task && typeof task === "object" && "id" in task) {
    const id = Reflect.get(task, "id");
    if (typeof id === "string") return id;
  }
  return undefined;
}

/** Answer an open implementation-phase escalation → complete the parked `feature-escalation` user
 * task with the typed `{ resolution: "answer", answer }` completion, resuming the child so it loops
 * back to re-dispatch the SAME task on its existing branch. Keyed by the correlation key
 * (`<plan_key>:<task_id>`) so an external webhook and the inbox share one path. A corr_key with no
 * open task is a 404-style no-op. */
export async function answerTaskEscalation(
  data: DataLayer,
  engine: EngineClient,
  corrKey: string,
  answer: string,
) {
  const idx = corrKey.lastIndexOf(":");
  if (idx <= 0) return { ok: false, reason: "no open escalation" };
  const planKey = corrKey.slice(0, idx);
  const taskId = corrKey.slice(idx + 1);
  // Require a non-empty taskId: an empty suffix (e.g. "owner/repo#9:") would otherwise fall
  // through to the single-candidate fallback below and complete an arbitrary open feature
  // escalation for the plan.
  if (!taskId) return { ok: false, reason: "no open escalation" };
  const plan = await plans(data).get(planKey);
  if (!plan?.process_key) return { ok: false, reason: "no open escalation" };

  const open = await engine.searchUserTasks({ processInstanceKey: plan.process_key });
  const candidates = open.filter((t) => t.elementId === FEATURE_ESCALATION_TASK);
  const match = candidates.find((t) => userTaskTaskId(t.variables) === taskId) ??
    (candidates.length === 1 ? candidates[0] : undefined);
  if (!match) return { ok: false, reason: "no open escalation" };

  // Mirror onto the task row first so a re-dispatched agent (and the UI) sees the answer.
  // Completing the user task resumes the process, so if the DB write threw afterwards the open
  // task would be gone and a retry could no longer find it — leaving the row permanently
  // un-mirrored. Mirror first, then complete, so any failure stays retriable.
  const ts = now();
  for (const t of await planTasks(data).find({ plan_key: planKey, task_id: taskId })) {
    await planTasks(data).update(t.id, { answer, updated_at: ts });
  }
  await completeUserTaskAttributed(
    data,
    engine,
    {
      userTaskKey: match.userTaskKey,
      processInstanceKey: plan.process_key,
      elementId: match.elementId,
      variables: { resolution: "answer", answer },
    },
    { kind: "human", id: "operator" },
  );
  return { ok: true, userTaskKey: match.userTaskKey, planKey, taskId };
}

/** Answer the open plan-review escalation → complete the parked `plan-review-decision` user task
 * with the typed `{ directive, notes }` completion. `proceed` is an explicit human override that
 * lets the current (unapproved) plan continue to wave dispatch; `revise` (the default) folds the
 * human notes into `planFindings` and starts a fresh review epoch (both handled by the user task's
 * ioMapping) on the next planner pass. A plan with no parked decision task is a 404-style no-op. */
export async function answerPlanEscalation(
  data: DataLayer,
  engine: EngineClient,
  planKey: string,
  directiveInput: unknown,
  noteInput: unknown,
) {
  const plan = await plans(data).get(planKey);
  if (!plan?.process_key) return { ok: false, reason: "no open plan escalation" };
  const open = await engine.searchUserTasks({ processInstanceKey: plan.process_key });
  const match = open.find((t) => t.elementId === PLAN_REVIEW_DECISION_TASK);
  if (!match) return { ok: false, reason: "no open plan escalation" };

  const directive = normalizePlanEscalationDirective(directiveInput);
  const notes = typeof noteInput === "string" ? noteInput.trim() : "";
  await completeUserTaskAttributed(
    data,
    engine,
    {
      userTaskKey: match.userTaskKey,
      processInstanceKey: plan.process_key,
      elementId: match.elementId,
      variables: { directive, notes },
    },
    { kind: "human", id: "operator" },
  );
  return { ok: true, userTaskKey: match.userTaskKey, planKey, directive };
}
