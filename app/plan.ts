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
import { blackboardUrl, mintBlackboardToken, renderCoordinationBrief } from "./blackboard.ts";
import { ensureBaseBranch, fetchDefaultBranch } from "./github.ts";
import { clearExclusions } from "./mergeExclusion.ts";
import { clearTaskDeltas } from "./taskDelta.ts";
import { resolveTrialMergeAttention, trialMergeWaveFromTaskId } from "./trialMerge.ts";

/** The BPMN process this module drives (resources/processes/plan-fanout.bpmn). */
export const PLAN_PROCESS_ID = "plan-fanout";

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
  // Target base branch (019_plan_base_branch.sql; ADR 0003): the fleet branches off this branch and
  // opens every task PR against it instead of the repository's default branch, landing the whole
  // epic on a long-lived integration branch. New launches always set it (base is required at
  // admission); the column stays NULLABLE ONLY to grandfather pre-ADR-0003 / in-flight rows that
  // carry NULL — those must remain readable, so do NOT add a NOT NULL migration.
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

/** The message the plan-fanout process catches to resume an escalated task; its
 * subscription correlates on `<plan_key>:<task_id>` (see plan-fanout.bpmn). */
export const FEATURE_ESCALATION_MESSAGE = "feature-escalation-answered";

/** The message the plan-fanout process catches to resume a plan-review escalation; its
 * subscription correlates on `<plan_key>` (see plan-fanout.bpmn). */
export const PLAN_ESCALATION_MESSAGE = "plan-escalation-answered";

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

export function parsePlanEscalationDirective(input: unknown): PlanEscalationDirective | null {
  const s = typeof input === "string" ? input.trim().toLowerCase() : "";
  return s === "proceed" || s === "revise" ? s : null;
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

/** The current review epoch is derived from the append-only escalation log: every answered
 * plan-review escalation represents a human decision to leave the prior budget behind. */
export async function currentPlanReviewEpoch(data: DataLayer, planKey: string): Promise<number> {
  return await planReviewEscalations(data).count({ plan_key: planKey, status: "answered" });
}

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

/** Raised when a caller supplies a blank/absent `baseBranch`. Every epic launch must name its base
 * branch explicitly (ADR 0003): "land on the default branch" is a conscious, named, confirmed choice
 * (the confirm-default gate), never a silent fallback. The operation edge maps this to a 400. */
export class MissingBaseBranchError extends Error {
  constructor() {
    super("base branch is required (blank/absent base branches are rejected)");
    this.name = "MissingBaseBranchError";
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

/** Normalise a caller-supplied base branch: trim, then require it. A blank/absent value is rejected
 * (`MissingBaseBranchError`) — ADR 0003 removed the implicit default-branch fallback, so every epic
 * launch must name its base explicitly. A non-blank value that is not a plausible git branch name is
 * rejected (`InvalidBaseBranchError`) rather than persisted or rendered into the agent prompt. The
 * operation edge maps both to a 400. Always returns a non-null branch on success. */
export function normalizeBaseBranch(input: string | null | undefined): string {
  const s = (input ?? "").trim();
  if (s.length === 0) throw new MissingBaseBranchError();
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

/** Raised when the explicit base branch IS the repository default branch but the caller did not
 * acknowledge the consequence with `confirmDefaultBase: true` (ADR 0003 rule 3). Naming the default
 * is the one dangerous explicit value: every task lands directly on it with no integration buffer,
 * and any merge-to-default side effect fires per task. The operation edge maps this to a 400. */
export class DefaultBaseNotConfirmedError extends Error {
  readonly branch: string;
  constructor(branch: string) {
    super(
      `base branch "${branch}" is the repository default branch: every task would land directly ` +
        `on "${branch}" with NO integration branch, and any merge-to-default side effect (e.g. ` +
        `auto-publish) would fire per task. Re-submit with confirmDefaultBase: true to acknowledge ` +
        `and proceed, or name an epic/* integration branch instead.`,
    );
    this.name = "DefaultBaseNotConfirmedError";
    this.branch = branch;
  }
}

/** Raised when another ACTIVE plan (status ∉ PLAN_TERMINAL_STATUSES) already targets the same repo
 * + same custom base branch, and the caller did not pass `allowSharedBase: true` (ADR 0003 rule 4).
 * Two in-flight epics sharing one integration branch interleave commits and poison each other's
 * base. The default branch is EXEMPT (many epics target it concurrently without colliding — each
 * task PR is independent). The operation edge maps this to a 409. */
export class SharedBaseError extends Error {
  readonly repo: string;
  readonly branch: string;
  constructor(repo: string, branch: string) {
    super(
      `base branch "${branch}" on ${repo} is already in use by another active epic. Sharing one ` +
        `integration branch across epics interleaves their commits and poisons the base. Re-submit ` +
        `with allowSharedBase: true only if you intend to stack on it, or name a distinct epic/* ` +
        `branch.`,
    );
    this.name = "SharedBaseError";
    this.repo = repo;
    this.branch = branch;
  }
}

/** Find plans on `repo` targeting `base` whose status is NOT terminal (i.e. still active). Used by
 * the shared-base admission guard to detect a second epic reaching for the same integration branch.
 * Grandfathered `base_branch = null` rows never match a non-null `base`, so they are ignored. */
export async function findActivePlansByBase(
  data: DataLayer,
  repo: string,
  base: string,
): Promise<Plan[]> {
  const rows = await plans(data).find({ repo, base_branch: base });
  return rows.filter((p) => !PLAN_TERMINAL_STATUSES.includes(p.status));
}

/** Options gating the confirm-default (rule 3) and shared-base (rule 4) admission rules. Both
 * default to `false` — a "warn you can't skip": the operator must consciously opt in. */
export interface AdmitPlanOptions {
  allowSharedBase?: boolean;
  confirmDefaultBase?: boolean;
}

/** Fail-fast admission gate for an epic launch (ADR 0003 §Decision). Composes the four ordered
 * admission rules BEFORE any task fans out and returns the normalized base branch on success. The
 * ORDER is load-bearing — the cheapest / most fundamental reject (missing or typo'd base) fires
 * first, so it is NOT reordered:
 *
 *   1. Required + explicit — `normalizeBaseBranch` (blank/absent → `MissingBaseBranchError`;
 *      implausible → `InvalidBaseBranchError`).
 *   2. Create-if-missing (epic/* guard), synchronously — `ensureBaseBranch`: a missing non-`epic/*`
 *      base throws `BaseBranchMustExistError` HERE (so a typo is a clean edge 400, not a late
 *      per-task failure); a missing `epic/*` base is created off default HEAD before fan-out; an
 *      existing base is a no-op. It is idempotent, so the durable `ensure-base-branch` head task
 *      re-runs it as belt-and-suspenders.
 *   3. Confirm-default — if the base equals the repo default branch and `confirmDefaultBase` is not
 *      `true`, throw `DefaultBaseNotConfirmedError`. The default branch is then EXEMPT from rule 4.
 *   4. Shared-base — if an active plan already targets this same custom base and `allowSharedBase`
 *      is not `true`, throw `SharedBaseError`.
 */
export async function admitPlan(
  data: DataLayer,
  repo: string,
  baseBranch: string | null | undefined,
  token: string,
  options: AdmitPlanOptions = {},
): Promise<string> {
  // Rule 1 — required + explicit.
  const base = normalizeBaseBranch(baseBranch);

  // Rule 2 — create-if-missing (epic/* guard), synchronously at admission. A missing non-epic/*
  // base throws BaseBranchMustExistError → clean edge 400; a missing epic/* base is created off
  // default HEAD; an existing base is a no-op. Idempotent, so the head task safely re-runs it.
  await ensureBaseBranch(repo, base, token);

  // Rule 3 — confirm-default. Naming the repo default branch is deliberate and requires an explicit
  // acknowledgement. When the base IS the default, it is exempt from the shared-base guard (rule 4),
  // so return here on a confirmed default.
  const defaultBranch = await fetchDefaultBranch(repo, token);
  if (defaultBranch !== null && base === defaultBranch) {
    if (options.confirmDefaultBase !== true) throw new DefaultBaseNotConfirmedError(base);
    return base;
  }

  // Rule 4 — shared-base guard on a custom integration branch.
  if (options.allowSharedBase !== true) {
    const active = await findActivePlansByBase(data, repo, base);
    if (active.length > 0) throw new SharedBaseError(repo, base);
  }

  return base;
}

/** Register a plan row (if new) and start the plan-fanout process. Idempotent on
 * planKey: a plan already in flight is not restarted. */
export async function startPlan(
  data: DataLayer,
  engine: EngineClient,
  parsed: ParsedIssue,
  baseBranch: string,
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
    // Same class of stale-row bug for escalation state: task escalations are keyed on `id` (not
    // `plan_key`), so drop the prior run's rows one-by-one. Otherwise a still-"open" escalation
    // from the previous run survives the re-plan and `refreshOpenTaskEscalation` re-surfaces a
    // question for a `task_id` we just deleted from `plan_tasks`.
    for (const e of await planEscalations(data).find({ plan_key: parsed.planKey })) {
      await planEscalations(data).delete(e.id);
    }
    // Plan-review escalations are also keyed on `id` because they are an audit trail; clear them
    // on a fresh submission so the epoch derived from answered escalations resets to 0.
    for (const e of await planReviewEscalations(data).find({ plan_key: parsed.planKey })) {
      await planReviewEscalations(data).delete(e.id);
    }
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
      // Coordination blackboard (#51): the capability URL + the protocol brief that each
      // implementer agent gets appended to its prompt (composed into `appendPrompt` in
      // plan-fanout.bpmn's implement-task). Advisory shared state, delivered in-band, used
      // out-of-band.
      blackboardUrl: bbUrl,
      blackboardBrief: renderCoordinationBrief(bbUrl),
      // Epic base branch (019_plan_base_branch.sql; ADR 0003): the branch the fleet branches off
      // and opens every PR against instead of the repo default. `baseBranchBrief` rides
      // `appendPrompt` in the implement-task (like `blackboardBrief`). Base is now always explicit
      // (normalizeBaseBranch rejects blank), so the brief is always rendered.
      baseBranch: base,
      baseBranchBrief: renderBaseBranchBrief(base),
    },
  });
  const processKey = processInstanceKey == null ? null : String(processInstanceKey);
  if (processKey != null) {
    await table.update(parsed.planKey, { process_key: processKey, updated_at: now() });
  }
  return { planKey: parsed.planKey, processKey };
}

/** Re-point a plan's denormalised "open task escalation" fields at its OLDEST
 * still-open `plan_escalations` row (or clear them when none remain). The page
 * runtime binds a single answer form per plan row, so parallel escalations are
 * surfaced one at a time, oldest-first; this is called after opening an
 * escalation and after answering one. */
export async function refreshOpenTaskEscalation(data: DataLayer, planKey: string) {
  const open = (await planEscalations(data).find({ plan_key: planKey, status: "open" }))
    .sort((a, b) => a.id - b.id)[0];
  await plans(data).update(planKey, {
    open_task_escalation_id: open ? open.id : null,
    open_task_question: open ? open.question : null,
    open_task_corr_key: open ? open.corr_key : null,
    open_task_id: open ? open.task_id : null,
    updated_at: now(),
  });
}

/** Answer an open implementation-phase escalation → record it, resume the parked
 * task via the correlated `feature-escalation-answered` message, and re-surface
 * the next-oldest open escalation (if any). Keyed by the correlation key
 * (`<plan_key>:<task_id>`) so an external webhook and the page share one path.
 * Idempotent-ish: a corr_key with no open escalation is a 404-style no-op. */
export async function answerTaskEscalation(
  data: DataLayer,
  engine: EngineClient,
  corrKey: string,
  answer: string,
) {
  const open = (await planEscalations(data).find({ corr_key: corrKey, status: "open" }))
    .sort((a, b) => b.id - a.id)[0];
  if (!open) return { ok: false, reason: "no open escalation" };
  const ts = now();
  // A trial-merge escalation (task_id `trial-merge-wave-<wave>`) leaves an
  // append-only red audit row in `plan_trial_merges`. Answering it clears that
  // row from the page's "Needs attention" tab — including a "proceed" override
  // that records no re-run row (a re-run would supersede it, but a proceed would
  // not, pinning the red row forever).
  //
  // Resolve it FIRST, before the escalation is committed as answered and the
  // resume message is published. `resolveTrialMergeAttention` is idempotent, so
  // if this throws (e.g. a transient DB error) the escalation is still open and
  // the whole operation retries cleanly. Running it AFTER the commit/publish
  // would make a failure here unrecoverable: the escalation is already answered,
  // a retry 404s (no open escalation), and the red row is pinned forever.
  const trialWave = trialMergeWaveFromTaskId(open.task_id);
  if (trialWave != null) await resolveTrialMergeAttention(data, open.plan_key, trialWave);
  await planEscalations(data).update(open.id, { answer, status: "answered", answered_at: ts });
  // Mirror onto the task row so a re-dispatched agent (and the UI) sees the answer.
  for (const t of await planTasks(data).find({ plan_key: open.plan_key, task_id: open.task_id })) {
    await planTasks(data).update(t.id, { answer, updated_at: ts });
  }
  // Resume the parked child: the process merges `answer` into the child scope and
  // loops back to re-dispatch the SAME task on its existing branch.
  await engine.publishMessage({
    name: FEATURE_ESCALATION_MESSAGE,
    correlationKey: corrKey,
    variables: { answer },
  });
  await refreshOpenTaskEscalation(data, open.plan_key);
  return { ok: true, escalationId: open.id, planKey: open.plan_key, taskId: open.task_id };
}

export function normalizePlanEscalationDirective(input: unknown): PlanEscalationDirective {
  return parsePlanEscalationDirective(input) ?? "revise";
}

function renderPlanEscalationFindings(open: PlanReviewEscalation, note: string): string {
  const parts = [
    `Plan review reached its round budget at epoch ${open.epoch}, round ${open.round}.`,
    "",
    "Reviewer findings:",
    (open.findings ?? "").trim() || "(no reviewer findings were provided.)",
  ];
  if (note) {
    parts.push("", "Human guidance:", note);
  } else {
    parts.push("", "Human directive: revise the plan within the allowed task boundaries.");
  }
  return parts.join("\n");
}

/** Answer the newest open plan-review escalation. `proceed` is an explicit human override that lets
  * the current (unapproved) plan continue to wave dispatch; `revise` (the default) folds the human
  * note into `planFindings` and starts a fresh review epoch on the next planner pass. */
export async function answerPlanEscalation(
  data: DataLayer,
  engine: EngineClient,
  planKey: string,
  directiveInput: unknown,
  noteInput: unknown,
) {
  const open = (await planReviewEscalations(data).find({ plan_key: planKey, status: "open" }))
    .sort((a, b) => b.id - a.id)[0];
  if (!open) return { ok: false, reason: "no open plan escalation" };

  const directive = normalizePlanEscalationDirective(directiveInput);
  const note = typeof noteInput === "string" ? noteInput.trim() : "";
  const ts = now();
  await planReviewEscalations(data).update(open.id, {
    directive,
    note: note || null,
    status: "answered",
    answered_at: ts,
  });
  await plans(data).update(planKey, {
    open_plan_escalation_id: null,
    open_plan_findings: null,
    open_plan_round: null,
    updated_at: ts,
  });

  await engine.publishMessage({
    name: PLAN_ESCALATION_MESSAGE,
    correlationKey: planKey,
    variables: {
      planEscalationDirective: directive,
      planFindings: directive === "revise" ? renderPlanEscalationFindings(open, note) : "",
    },
  });
  return { ok: true, escalationId: open.id, planKey, directive };
}
