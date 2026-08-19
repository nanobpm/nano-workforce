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
import { deriveEpicBucket, epicIsAcknowledgeable } from "./delivery.ts";
import { EPIC_PHASE } from "./epicPhase.ts";
import { DEFAULT_ESCALATION_SLA_TIMEOUT, escalationSlaTimeout } from "./escalationSla.ts";
import { coalesceTitle, ensureBaseBranch, fetchDefaultBranch, fetchIssueTitle } from "./github.ts";
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
// `senior:feature` prompts are generic resources (`resources/prompts/plan.md` /
// `resources/prompts/plan-review.md` / `resources/prompts/feature.md`, deployed under the
// `resources/` deploy-by-convention layout — nano.app.json declares no `models`) linked into each
// task as
// `<zeebe:linkedResource … bindingType="latest" linkName="prompt"/>` and resolved by the engine at
// job activation. Per-instance dynamic context (a plan's rejection findings, a task's brief) rides
// `appendPrompt`, which the harness concatenates onto the linked base. The host only carries
// runtime identity + `planFindings`.

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
  // Derived epic delivery signal (029_plan_delivery.sql, #171): separates "fan-out dispatched to
  // convergence" (status=done) from "all slice PRs actually merged". Recomputed idempotently by the
  // poller's `pollDelivery` pass by joining each plan_tasks.pr_key → pull_requests.status — never
  // written by the plan lifecycle. `delivery` is 'converging' | 'landed' | NULL (see deriveDelivery
  // in app/service.ts); `delivery_label` is the human rollup for the epic detail view. Display-only.
  delivery: string | null;
  delivery_label: string | null;
  // Derived epic domain phase (038_plan_epic_phase.sql, #261): the epic's own lifecycle phase —
  // Planning / Reviewing / Implementing (wave n/t) / Trial merging / Finalizing / Dispatched —
  // projected at write time from plan-fanout.bpmn's named activities (app/epicPhase.ts), so the epic
  // view can show which phase the epic is IN rather than only the process-instance terminal status.
  // Display-only; NULL until the lifecycle first stamps it (grandfathers pre-#261 rows).
  epic_phase: string | null;
  // Epic integration-branch → default-branch promotion (042_plan_promotion.sql, #299). When an epic
  // targets a custom `epic/*` integration branch and every slice PR has merged (`delivery = landed`),
  // the poller's `pollPromotion` pass opens exactly ONE `epic/* → <default>` promotion PR and drives
  // it through the same convergence + merge protocol as every other PR (see app/promotion.ts).
  //   • promotion_pr    — the `owner/repo#N` key of that promotion PR, or NULL until one is opened.
  //                       PRIMARY idempotency key: a set value never re-opens a second PR.
  //   • promotion_state — the epic-card progression 'ready' → 'open' → 'promoted', or NULL until the
  //                       epic first becomes promotable (also NULL forever for a `main`-based epic,
  //                       which has nothing to promote). Display-only; projected by the poller.
  promotion_pr: string | null;
  promotion_state: string | null;
  // Active/History partition + operator tick-off (044_plan_list_bucket.sql, #298). Derived,
  // write-time-projected by the `plans` gateway (below) from the pure `deriveEpicBucket` /
  // `epicIsAcknowledgeable` helpers (app/delivery.ts) — never written by the plan lifecycle or a
  // poller directly. Bucket epics on the derived `delivery` rollup, not raw `status`, so a `done`
  // epic still converging — or landed-but-unpromoted — does not vanish from Active.
  //   • acknowledged_at — NULL until an operator dismisses a resolved `done` epic (acknowledge-epic).
  //   • list_bucket     — 'active' | 'history': the page tabs filter on this flat column.
  //   • ack_open        — 1 | 0: 1 iff a resolved (`done`, not converging) but unacknowledged epic,
  //                       gating the Dismiss button's `showWhenField`. NULL only on pre-#298 rows
  //                       until `backfillPlanBuckets`.
  acknowledged_at: string | null;
  list_bucket: string | null;
  ack_open: number | null;
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

export const plans = (data: DataLayer) => {
  const table = data.table<Plan>("plans", "plan_key");
  return new Proxy(table, {
    get(target, prop) {
      if (prop === "insert") {
        return (row: Partial<Plan>) => target.insert({ ...row, ...projectPlanBucket(row) });
      }
      if (prop === "update") {
        return async (id: unknown, patch: Partial<Plan>) => {
          // Only re-read + reproject when the patch changes a projection input (status / delivery /
          // acknowledged_at) or writes a derived column directly. A projection-irrelevant patch (e.g.
          // an `updated_at`- or `wave_label`-only write) leaves the stored projection correct — the
          // gateway is the sole write path — so skip the extra `get` roundtrip and delegate straight.
          if (!patchAffectsPlanProjection(patch)) return target.update(id, patch);
          const existing = await target.get(id);
          const merged: Partial<Plan> = { ...existing, ...patch };
          return target.update(id, { ...patch, ...projectPlanBucket(merged) });
        };
      }
      // Delegate every other method straight through. Bind functions to the real target so the
      // gateway's private class fields resolve — a Proxy `this` would not carry them.
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

/** The `plans` fields the bucket projection READS: a patch touching none of these (and none it
 * writes) cannot change `list_bucket`/`ack_open`, so the gateway skips the read-back+reproject. Kept
 * adjacent to {@link projectPlanBucket} so the two stay in lockstep. */
const PLAN_PROJECTION_INPUT_KEYS: readonly (keyof Plan)[] = ["status", "delivery", "acknowledged_at"];

/** The `plans` fields the bucket projection WRITES. Included in the reproject trigger so a caller who
 * writes a derived column directly (e.g. `list_bucket`/`ack_open`) can never bypass derivation: the
 * gateway re-reads, recomputes, and OVERRIDES the raw value with the canonical derived one. */
const PLAN_PROJECTION_OUTPUT_KEYS: readonly (keyof Plan)[] = ["list_bucket", "ack_open"];

/** True when a patch changes at least one field the bucket projection derives from OR one it writes —
 * i.e. the projection must be recomputed (mirrors feature.ts `patchAffectsProjection`). */
function patchAffectsPlanProjection(patch: Partial<Plan>): boolean {
  return (
    PLAN_PROJECTION_INPUT_KEYS.some((k) => k in patch) ||
    PLAN_PROJECTION_OUTPUT_KEYS.some((k) => k in patch)
  );
}

/** Compute the write-time bucket projection columns for a merged `plans` row. Centralised so the
 * gateway is the ONE place `deriveEpicBucket` / `epicIsAcknowledgeable` are applied — the page, SQL,
 * pollers and workers never re-derive the mapping (AGENTS.md "derivation over duplication"). */
function projectPlanBucket(row: Partial<Plan>): Partial<Plan> {
  if (!row.status) return {};
  return {
    list_bucket: deriveEpicBucket(row.status, row.delivery ?? null, row.acknowledged_at ?? null),
    ack_open:
      epicIsAcknowledgeable(row.status, row.delivery ?? null) && (row.acknowledged_at ?? null) === null
        ? 1
        : 0,
  };
}

/** Re-project every `plans` row through the gateway so rows written before migration 042 (whose
 * `list_bucket`/`ack_open` are NULL) get a correct Active/History bucket. Idempotent and safe to
 * re-run: it re-derives from each row's own stored fields, so a second pass is a no-op. Runs once at
 * boot (pollOnce) — the gateway keeps every future write fresh, so this only needs to catch legacy
 * rows. Returns the count actually stamped. Mirrors `backfillFeatureStages` (app/feature.ts). */
export async function backfillPlanBuckets(data: DataLayer): Promise<number> {
  const table = plans(data);
  let stamped = 0;
  for (const row of await table.all()) {
    // Only touch rows the projection has never reached — a legacy row whose `list_bucket` is NULL.
    if (row.list_bucket != null) continue;
    await table.update(row.plan_key, projectPlanBucket(row));
    stamped++;
  }
  return stamped;
}
export const planTasks = (data: DataLayer) => data.table<PlanTask>("plan_tasks", "id");

/** One dependency edge in the plan DAG (issue #20): `task_id` waits for `depends_on_task_id`.
 * Keyed on `plan_key` so a single delete clears a plan's whole edge set (as pr_dependencies). */
export interface PlanTaskDep {
  plan_key: string;
  task_id: string;
  depends_on_task_id: string;
}
export const planTaskDeps = (data: DataLayer) =>
  data.table<PlanTaskDep>("plan_task_deps", "plan_key");

/** One INTER-epic dependency edge in the plan-set DAG (issue #292, slice S1): the epic `plan_key`
 * waits for the producer epic `depends_on_plan_key` to publish a capability before it may fan out.
 *
 * This is the coarser sibling of {@link PlanTaskDep} (which orders TASKS *within* one epic into
 * waves). A `PlanDep` orders whole EPICS relative to each other. The edge additionally carries the
 * gating contract descriptor the capability probe (slice S3) resolves against:
 *   • `package` — the producer epic's published package name, and
 *   • `capability_ref` — the producer epic's issue handle, used to resolve which published
 *     `pkg@version` FIRST carries the awaited capability (late-bound into the dependent's build).
 * Keyed on `plan_key` (the dependent) so a single delete clears a dependent's whole inbound edge set
 * — mirroring how `plan_task_deps` is keyed on `plan_key`. See db/migrations/041_inter_epic_plan_deps.sql
 * for the durable constraints (one edge per consumer→producer pair; no self-edge). */
export interface PlanDep {
  plan_key: string;
  depends_on_plan_key: string;
  package: string;
  capability_ref: string;
  created_at: string;
}
export const planDeps = (data: DataLayer) => data.table<PlanDep>("plan_deps", "plan_key");

/** The fields an admission caller supplies for one inter-epic edge; `created_at` is stamped here. */
export type PlanDepInput = Omit<PlanDep, "created_at">;

/** Record one inter-epic dependency edge, enforcing the schema's two invariants at the app layer too
 * (the durable table backstops both, but the in-memory test data layer does not): an epic may not
 * depend on itself, and a consumer→producer edge is recorded at most once. A duplicate re-submission
 * is a no-op that returns the existing row rather than throwing, so batch admission (S2) stays
 * idempotent; a self-edge is a programming/validation error and throws. */
export async function recordPlanDep(data: DataLayer, edge: PlanDepInput): Promise<PlanDep> {
  if (edge.plan_key === edge.depends_on_plan_key) {
    throw new Error(
      `plan_deps: self-edge rejected — epic ${edge.plan_key} cannot depend on itself`,
    );
  }
  const table = planDeps(data);
  const match = { plan_key: edge.plan_key, depends_on_plan_key: edge.depends_on_plan_key };
  const existing = (await table.find(match))[0];
  if (existing) return existing;
  const row: PlanDep = { ...edge, created_at: now() };
  try {
    await table.insert(row);
    return row;
  } catch (err) {
    // A concurrent caller may have inserted the same consumer→producer pair between our find and
    // our insert (classic check-then-insert race); the composite PRIMARY KEY is the durable
    // backstop that rejects the loser. Honour the "duplicate re-submission is a no-op" contract by
    // re-reading and returning the winning row rather than surfacing the constraint error. Only a
    // genuine non-collision failure (the pair still absent after the re-read) is re-raised.
    const raced = (await table.find(match))[0];
    if (raced) return raced;
    throw err;
  }
}

/** All INBOUND edges for `planKey` — i.e. every producer epic this dependent waits on. Empty for a
 * root epic (no inter-epic dependencies). */
export function inboundPlanDeps(data: DataLayer, planKey: string): Promise<PlanDep[]> {
  return planDeps(data).find({ plan_key: planKey });
}

/** Every inter-epic edge whose dependent is in `planKeys` — the whole DAG for a submitted plan set.
 * Reads per-key (not a table scan) so it composes with the same equality-filtered data layer the
 * unit tests exercise. Producers outside the set are still returned as edge fields; the set
 * validator (S3) is what rejects an edge naming an unsubmitted epic. */
export async function planDepsForSet(data: DataLayer, planKeys: string[]): Promise<PlanDep[]> {
  const seen = new Set<string>();
  const out: PlanDep[] = [];
  // De-duplicate the keys first so a repeated key (retries / accidental repeats) does not trigger a
  // redundant per-key inbound read; the edge de-dup below still guards against any overlap.
  for (const key of new Set(planKeys)) {
    for (const edge of await inboundPlanDeps(data, key)) {
      const id = `${edge.plan_key}\u0000${edge.depends_on_plan_key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(edge);
    }
  }
  return out;
}

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
 * resources/prompts/feature.md, so the agent branches off — and opens its PR against — the integration
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
  /** The `plan_key` of the launch being admitted. When set, the shared-base guard (rule 4)
   * EXCLUDES this plan's own active row, so an idempotent re-submit of the same issue does not
   * trip `SharedBaseError` against itself — `startPlan` is idempotent on `plan_key` and returns
   * `alreadyRunning` for an active plan, so the retry must reach it, not 409 on rule 4. */
  selfPlanKey?: string;
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
 *   4. Shared-base — if a DIFFERENT active plan already targets this same custom base and
 *      `allowSharedBase` is not `true`, throw `SharedBaseError`. The launch's own active row is
 *      excluded (via `options.selfPlanKey`) so an idempotent same-issue re-submit is not a 409.
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

  // Rule 4 — shared-base guard on a custom integration branch. Exclude this launch's OWN active row
  // (when `selfPlanKey` is given) so an idempotent same-issue re-submit reaches `startPlan`'s
  // `alreadyRunning` short-circuit instead of tripping a 409 against itself.
  if (options.allowSharedBase !== true) {
    const active = (await findActivePlansByBase(data, repo, base)).filter(
      (p) => p.plan_key !== options.selfPlanKey,
    );
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
  // Human-readable identity for the epics grids (issue #248): fetch the epic issue's title,
  // best-effort. Coalesce to the `owner/repo#N` key at write time so `plans.title` is ALWAYS
  // non-blank — the grid's `{{title}}` template then needs no fallback, and a failed/absent/blank
  // fetch still shows a usable identity (the key) rather than an empty cell. A fetch failure never
  // blocks the start (`fetchIssueTitle` returns null on any error).
  const title = coalesceTitle(
    await fetchIssueTitle(parsed.repo, parsed.number, process.env.GITHUB_TOKEN ?? ""),
    parsed.planKey,
  );
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
      title,
      outcome: null,
      // Genesis of the domain lifecycle (#261): the epic re-enters Planning. Cleared of any stale
      // terminal phase from the prior run so the re-plan reads correctly from the first pass.
      epic_phase: EPIC_PHASE.PLANNING,
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
      title,
      status: "planning",
      task_count: 0,
      // Genesis of the domain lifecycle (#261): a fresh epic starts in Planning.
      epic_phase: EPIC_PHASE.PLANNING,
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

