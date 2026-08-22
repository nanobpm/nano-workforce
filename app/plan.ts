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
import { capsWaitTimeout, DEFAULT_CAPS_WAIT_TIMEOUT } from "./capsWait.ts";
import { EPIC_PHASE } from "./epicPhase.ts";
import { DEFAULT_ESCALATION_SLA_TIMEOUT, escalationSlaTimeout } from "./escalationSla.ts";
import {
  BaseBranchMustExistError,
  coalesceTitle,
  ensureBaseBranch,
  fetchDefaultBranch,
  fetchIssueTitle,
} from "./github.ts";
import { clearExclusions } from "./mergeExclusion.ts";
import type { ReadinessProbe } from "./readiness.ts";
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

/** The fleet-wide capability-barrier bound (ISO-8601 duration) seeded onto every plan-fanout instance
 * as the `capsWaitTimeout` process variable and evaluated by the `wait-caps-timeout` timer arm of the
 * `wait-caps-resolved` event-based gateway. An operator sets `NANO_CAPS_WAIT_TIMEOUT`; a malformed
 * value falls back to {@link DEFAULT_CAPS_WAIT_TIMEOUT} so a bad env can never deploy an
 * uninterpretable timer. Bounds a task's wait on an unresolvable cross-repo capability so it escalates
 * to an operator instead of parking forever. */
export const CAPS_WAIT_TIMEOUT = capsWaitTimeout(
  process.env.NANO_CAPS_WAIT_TIMEOUT,
  DEFAULT_CAPS_WAIT_TIMEOUT,
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
  // Operator-visibility wave progress is now a DERIVED read model (epic #412): the `wave_count` /
  // `current_wave` / `wave_label` columns (022_plan_wave_progress.sql) were RETIRED — the pages read
  // them from the `plan_wave_label` / `plan_read_model` SQL VIEWs (060/061), and `pollWaitGate`
  // derives "has the epic fanned out?" at read time from `plan_tasks`. There is no write-path and no
  // stored column any more, so nothing on `plans` denormalises wave progress.
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
  // The derived epic delivery signal (029_plan_delivery.sql) was RETIRED as a stored column (epic
  // #412): `delivery` / `delivery_label` are now a DERIVED SQL VIEW (`plan_delivery` /
  // `plan_read_model`, 061), computed from the SAME pure `deriveDelivery`/`TERMINAL_STATUSES`
  // (app/delivery.ts). The pages read them off the view; the pollers that still need the signal
  // (`pollPromotion` for `isPromotable`) recompute it at
  // read time via `deriveDelivery`, as does the `plan_read_model` VIEW's bucket derivation (066).
  // There is no stored column and no write-path any more.
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
  // Active/History partition + operator tick-off (044_plan_list_bucket.sql, #298). RETIRED as a
  // write-time projection (issue #439): `list_bucket`/`ack_open` are now DERIVED by the
  // `plan_read_model` VIEW (066) from `status`, `acknowledged_at`, and the derived `plan_delivery`
  // signal — mirroring the pure `deriveEpicBucket` / `epicIsAcknowledgeable` (app/delivery.ts). The
  // Epics pages bind the VIEW, never these base columns, so a raw-datasource `status` write (the
  // `instanceTracking` reconciler) can no longer leave them stale, and the delivery-aware
  // `pollPlanBucket` correction is retired (the VIEW sees the live signal). The base columns survive
  // (expand/contract — a later migration drops them) but are no longer written or read.
  //   • acknowledged_at — NULL until an operator dismisses a resolved `done` epic (acknowledge-epic).
  //                       Still written; the sole live input the derivation reads off the row.
  //   • list_bucket     — 'active' | 'history': VESTIGIAL base column; the pages filter the VIEW's.
  //   • ack_open        — 1 | 0: VESTIGIAL base column; the pages gate Dismiss on the VIEW's.
  acknowledged_at: string | null;
  list_bucket: string | null;
  ack_open: number | null;
  // Operator visibility for the inter-epic gate (047_plan_wait_gate.sql, #292 slice S4). Derived,
  // display-only projection over the S1 `plan_deps` edges + this epic's own S3 preflight lifecycle —
  // recomputed idempotently by `pollWaitGate` (app/service.ts) from the pure `deriveWaitGate`
  // (app/waitGate.ts); NEVER written by admission/scheduling (this slice is read-only). A ROOT epic
  // (no inbound edge) carries NULL for both — it shows no wait-gate; pre-S4 rows grandfather in NULL.
  //   • wait_gate       — 'waiting' (parked at the preflight, blocked on a producer's capability) |
  //                       'ready' (preflight green, fanned out, bound to a version) | 'escalated'
  //                       (the gate's bounded timeout elapsed with no publish).
  //   • wait_gate_label — the human at-a-glance rollup the epic index/detail read as a flat column.
  wait_gate: string | null;
  wait_gate_label: string | null;
  // JSON array of the resolved `pkg@version` strings the S3 preflight bound (the exact versions first
  // carrying each producer's capability), stamped by the `select-wave` worker from the
  // `resolvedArtifacts` process variable once the gate goes green. NULL until green / for roots.
  bound_artifacts: string | null;
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
  // Terminal: the task's PR was closed on GitHub without merging (abandoned / superseded /
  // perpetually conflicting). Set by the canonical abandon writer (`abandonClosedPr`, app/service.ts)
  // reached from BOTH the merge stage and the wave-merge gate. An `abandoned` task drops out of
  // `waveMergeTargets` (so a dead member never wedges the wave barrier — #352) and stops
  // `isPlanComplete`/the Epics table counting a phantom open task.
  "abandoned",
] as const;
export type PlanTaskStatus = typeof PLAN_TASK_STATUSES[number];

/** The `plans` record gateway (keyed on `plan_key`) — a plain record table.
 *
 * The epic-bucket projection (`list_bucket`/`ack_open`) is NO LONGER a write-time projection here
 * (issue #439): it is DERIVED by the `plan_read_model` VIEW (066) from each row's own `status` /
 * `acknowledged_at` and the derived `plan_delivery` signal, mirroring `deriveEpicBucket` /
 * `epicIsAcknowledgeable` (app/delivery.ts). The Epics pages bind the VIEW, never this table's stored
 * derived columns. Removing the write-time projection closes the drift the framework
 * `instanceTracking` reconciler opened (a raw-datasource `{status:"abandoned"}` write on a terminated
 * instance bypassed the projecting gateway and froze the bucket) AND retires the read-time
 * `pollPlanBucket` correction: the VIEW sees the live delivery signal, so a still-converging epic never
 * offers Dismiss without a poller pass. The pure helpers stay the acknowledge-epic guard and the VIEW's
 * test oracle (app/plansReadModel.test.ts). */
export const plans = (data: DataLayer) => data.table<Plan>("plans", "plan_key");
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

/** One cross-repo CAPABILITY EDGE on a plan task (049_plan_task_needs.sql, issue #289): the
 * consuming `task_id` must not start until the upstream capability `capability_ref` first ships as
 * a published `package` version. Levelized from the planner's `RecordPlanTask.needs[]` by
 * `pr.record-plan`, read back by `pr.select-wave` to gate the task before dispatch. Keyed on
 * `plan_key` (like {@link PlanTaskDep}) so one delete clears a plan's whole need set on re-plan.
 *
 * `capability_ref` is the STABLE handle (`owner/repo#NNN` | `repo#NNN` | `#NNN`) — NEVER a version
 * (the #263 core decision). `package` is the per-package-scoped provenance artifact. `verify_command`
 * is the optional gated empirical fallback (#274 decision 5); NULL means deterministic-provenance-only. */
export interface PlanTaskNeed {
  plan_key: string;
  task_id: string;
  capability_ref: string;
  package: string;
  verify_command: string | null;
}
export const planTaskNeeds = (data: DataLayer) =>
  data.table<PlanTaskNeed>("plan_task_needs", "plan_key");

/** One host-orchestrated CAPABILITY GATE (050_capability_gates.sql, issue #289): the durable,
 * idempotent state the `pollCapabilityGatesImpl` reconciler keeps for ONE (plan, task, capability
 * need) while its plan-fanout fan-out is parked at the `wait-caps-resolved` barrier. The host starts
 * the EXISTING `readiness-gate` process (#258) per need — recording its instance key on `process_key`
 * so it starts exactly once — and, each pass, reconciles whether the capability has shipped as a
 * published `pkg@version`; on match it stamps `resolved_artifact` and flips `status` to `resolved`.
 * When every one of a task's needs is `resolved` the reconciler publishes `caps-resolved` (releasing
 * the barrier with the late-bound brief). Keyed on the readiness-gate correlation key
 * `<plan_key>:<task_id>:<capability_ref>:<package>` ({@link capabilityGateKey}) so a host restart
 * re-derives the whole picture from the DB — never re-starting a gate nor re-publishing a settled
 * barrier. `package` is part of the key so two needs sharing a `capability_ref` across different
 * packages never collide on one gate row. */
export interface CapabilityGate {
  gate_key: string;
  plan_key: string;
  task_id: string;
  capability_ref: string;
  package: string;
  status: string;
  resolved_artifact: string | null;
  process_key: string | null;
  created_at: string;
  updated_at: string;
}
export const capabilityGates = (data: DataLayer) =>
  data.table<CapabilityGate>("capability_gates", "gate_key");
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

/** The record-gateway shape both the durable `plan_deps` table and its FK-free admission-staging
 * twin `admitted_plan_deps` expose. Both hold the identical {@link PlanDep} row, so the idempotent
 * edge-insert below is written once against this shape and reused for both. */
type PlanDepTable = ReturnType<typeof planDeps>;

/** Insert one inter-epic edge into `table` idempotently, enforcing the schema's two invariants at
 * the app layer too (the durable table backstops both, but the in-memory test data layer does not):
 * an epic may not depend on itself, and a consumer→producer edge is recorded at most once. A
 * duplicate re-submission is a no-op that returns the existing row rather than throwing, so batch
 * admission (S2) stays idempotent; a self-edge is a programming/validation error and throws. `label`
 * only names the offending table in the self-edge error. */
async function insertEdgeIdempotent(
  table: PlanDepTable,
  label: string,
  edge: PlanDepInput,
): Promise<PlanDep> {
  if (edge.plan_key === edge.depends_on_plan_key) {
    throw new Error(`${label}: self-edge rejected — epic ${edge.plan_key} cannot depend on itself`);
  }
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

/** Record one inter-epic dependency edge into the durable `plan_deps` graph. Idempotent on the
 * consumer→producer pair; a self-edge throws. NOTE: `plan_deps.plan_key` foreign-keys to an admitted
 * `plans` row, so this is written by slice S3 (planner lowering), NOT by the S2 admission door —
 * S2 stages edges FK-free via {@link recordAdmittedPlanDep} instead. */
export function recordPlanDep(data: DataLayer, edge: PlanDepInput): Promise<PlanDep> {
  return insertEdgeIdempotent(planDeps(data), "plan_deps", edge);
}

/** One STAGED admitted epic (issue #292 slice S2, db/migrations/045_epic_set_admission_staging.sql):
 * the FK-free record the set/batch admission door persists per admitted epic so a crash between
 * admission and lowering does not lose the set. It carries exactly what slice S3 (lowering) needs to
 * MATERIALIZE the durable `plans` row — repo, issue number/url, and the normalized integration base
 * branch admitPlan resolved. Keyed on `plan_key`, one staged row per epic (idempotent re-submit). */
export interface AdmittedEpic {
  plan_key: string;
  repo: string;
  issue_number: number;
  issue_url: string;
  base_branch: string;
  created_at: string;
}
export const admittedEpics = (data: DataLayer) =>
  data.table<AdmittedEpic>("admitted_epics", "plan_key");

/** The FK-free staging twin of `plan_deps` (db/migrations/045_epic_set_admission_staging.sql): the
 * validated inter-epic edges the S2 admission door stages before any `plans` row exists. Same row
 * shape as {@link PlanDep}; slice S3 reads it to materialize the durable `plan_deps` edges. */
export const admittedPlanDeps = (data: DataLayer) =>
  data.table<PlanDep>("admitted_plan_deps", "plan_key");

/** The fields an admission caller supplies for one staged admitted epic; `created_at` is stamped
 * here (mirrors {@link PlanDepInput}). */
export type AdmittedEpicInput = Omit<AdmittedEpic, "created_at">;

/** Stage one admitted epic (issue #292 slice S2). Idempotent on `plan_key`: a re-submitted set that
 * re-admits the same epic is a no-op returning the existing staged row, so the whole set door stays
 * idempotent (mirroring {@link recordAdmittedPlanDep}). */
export async function recordAdmittedEpic(
  data: DataLayer,
  epic: AdmittedEpicInput,
): Promise<AdmittedEpic> {
  const table = admittedEpics(data);
  const existing = await table.get(epic.plan_key);
  if (existing) return existing;
  const row: AdmittedEpic = { ...epic, created_at: now() };
  try {
    await table.insert(row);
    return row;
  } catch (err) {
    // Concurrent re-admission of the same epic races on the PRIMARY KEY (plan_key); honour the
    // idempotent no-op contract by returning the winning row rather than surfacing the collision.
    const raced = await table.get(epic.plan_key);
    if (raced) return raced;
    throw err;
  }
}

/** Stage one validated inter-epic edge (issue #292 slice S2) into the FK-free `admitted_plan_deps`
 * table. Idempotent on the consumer→producer pair; a self-edge throws. This is the S2 door's
 * persistence for edges — it does NOT touch `plan_deps` (whose FK requires a `plans` row S2 has not
 * created); slice S3 materializes the durable edge from this staging. */
export function recordAdmittedPlanDep(data: DataLayer, edge: PlanDepInput): Promise<PlanDep> {
  return insertEdgeIdempotent(admittedPlanDeps(data), "admitted_plan_deps", edge);
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

/** Map an error thrown by {@link admitPlan} to the HTTP status + message the admission-door
 * operations return at the edge, or `null` when the error is not an admission decision and must be
 * re-raised (a genuine 500). Shared by the single-issue door (`startPlanFanout`) and the set/batch
 * door (`startEpicSet`, issue #292 S2) so both map an epic's admission failure identically — a base
 * rule reject is a 400, the shared-base conflict a 409. Keeping this in ONE place stops the two doors
 * drifting on which admission failure maps to which status. */
export function admitPlanErrorResponse(err: unknown): { status: number; error: string } | null {
  if (err instanceof MissingBaseBranchError) {
    return {
      status: 400,
      error: "baseBranch is required (name the integration branch, e.g. epic/agent-protocol)",
    };
  }
  if (err instanceof InvalidBaseBranchError) {
    return {
      status: 400,
      error: "invalid baseBranch (must be a plausible git branch name, e.g. epic/agent-protocol)",
    };
  }
  if (err instanceof BaseBranchMustExistError) {
    return {
      status: 400,
      error:
        `baseBranch "${err.branch}" does not exist and is not an epic/* branch, so it is not ` +
        `auto-created — create it first, or use the epic/* convention`,
    };
  }
  if (err instanceof DefaultBaseNotConfirmedError) {
    return {
      status: 400,
      error:
        `baseBranch "${err.branch}" is the repository default branch — every task would land ` +
        `directly on it with no integration branch. Re-submit with confirmDefaultBase: true to proceed`,
    };
  }
  if (err instanceof SharedBaseError) {
    return {
      status: 409,
      error:
        `baseBranch "${err.branch}" is already in use by another active epic. Re-submit with ` +
        `allowSharedBase: true to stack on it, or name a distinct epic/* branch`,
    };
  }
  return null;
}

// ── Set/batch admission (issue #292, slice S2) ───────────────────────────────
// The set-admission door (`operations/startEpicSet.ts`) admits a WHOLE set of epics plus the
// inter-epic dependency edges between them in one all-or-nothing call. The pure validation below
// (reference integrity + DAG check) runs BEFORE any `admitPlan` side effect, so a malformed set is a
// clean 4xx with nothing half-started (no base branch created, no edge persisted). The door's only
// durable write is staging the admitted epics + validated edges FK-free into `admitted_epics` /
// `admitted_plan_deps`; materializing them into `plans` / `plan_deps` and scheduling/lowering
// (starting roots, seeding the capability readiness-gate, version binding) is slice S3.

/** One inter-epic dependency edge as SUBMITTED to the set door: the `consumer` epic waits for the
 * `producer` epic to publish the `{ package, capabilityRef }` capability. `consumer`/`producer` are
 * epic references (`owner/repo#N` or an issue URL); the door resolves them to plan keys. This type
 * documents the wire contract only — the actual `deps[]` arrives untyped, so {@link validateEpicSet}
 * validates each entry against this shape at runtime rather than trusting the type. */
export interface EpicSetDepInput {
  consumer: string;
  producer: string;
  package: string;
  capabilityRef: string;
}

/** A validated inter-epic edge — both endpoints resolved to plan keys, ready to persist as a
 * {@link PlanDep} (`plan_key = consumer`, `depends_on_plan_key = producer`). */
export interface ResolvedEpicSetDep {
  consumer: string;
  producer: string;
  package: string;
  capabilityRef: string;
}

/** A set-admission validation failure that carries the HTTP status the door returns at the edge
 * (always a 4xx — a malformed set is the caller's error, not a server fault). */
export class EpicSetValidationError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "EpicSetValidationError";
    this.status = status;
  }
}

/** Narrow an untyped value to a plain object so its fields can be read as `unknown`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Pure, side-effect-free validation of a submitted epic set's SHAPE and DAG — run BEFORE any
 * `admitPlan` call so a cycle or dangling edge is rejected with nothing half-started. Given the
 * submitted set's plan keys (already parsed, in submission order) and the raw edges, it:
 *   • rejects an empty set;
 *   • rejects a duplicate epic in the set;
 *   • parses each edge endpoint and rejects an unparseable/self/dangling edge (an endpoint not in
 *     the submitted set);
 *   • rejects a blank `package`/`capabilityRef`;
 *   • rejects a cycle in the consumer→producer graph, naming the edge that closes it.
 * Returns the edges with both endpoints resolved to plan keys. Throws {@link EpicSetValidationError}
 * (status 400) at the first offending input. Idempotent-friendly: a duplicate EDGE (same
 * consumer→producer submitted twice) is collapsed, not rejected, so a retried set validates.
 *
 * `deps` is accepted as `unknown[]` because it arrives straight from an untyped request body
 * (`startEpicSet` forwards `body.deps` verbatim). Every entry's shape is therefore validated
 * defensively here — a non-object entry (`null`, `{}`), or a non-string endpoint / `package` /
 * `capabilityRef`, maps to a clean {@link EpicSetValidationError} (400), never an uncaught
 * TypeError (500). */
export function validateEpicSet(planKeys: string[], deps: readonly unknown[]): ResolvedEpicSetDep[] {
  if (planKeys.length === 0) {
    throw new EpicSetValidationError(400, "epic set is empty — submit at least one epic");
  }
  const inSet = new Set<string>();
  for (const key of planKeys) {
    if (inSet.has(key)) {
      throw new EpicSetValidationError(400, `epic ${key} appears more than once in the submitted set`);
    }
    inSet.add(key);
  }

  const resolveEndpoint = (ref: string, role: "consumer" | "producer"): string => {
    // Trim like the epic-member path (`parseIssue(ref.trim())` in startEpicSet) so an otherwise-valid
    // padded endpoint (" owner/repo#1 ") from an untyped JSON payload is not rejected as unparseable.
    const parsed = parseIssue(ref.trim());
    if (!parsed) {
      throw new EpicSetValidationError(
        400,
        `dependency ${role} "${ref}" could not be parsed (use owner/repo#123 or an issue URL)`,
      );
    }
    if (!inSet.has(parsed.planKey)) {
      throw new EpicSetValidationError(
        400,
        `dependency ${role} ${parsed.planKey} is not one of the submitted epics — every edge must ` +
          `connect two epics in the set`,
      );
    }
    return parsed.planKey;
  };

  const resolved: ResolvedEpicSetDep[] = [];
  const seenEdges = new Set<string>();
  // consumer plan key → set of producer plan keys it depends on (for the DAG / cycle check).
  const adjacency = new Map<string, Set<string>>();
  for (const rawDep of deps) {
    if (!isRecord(rawDep)) {
      throw new EpicSetValidationError(
        400,
        "each dependency must be an object with consumer, producer, package and capabilityRef fields",
      );
    }
    if (typeof rawDep.consumer !== "string" || typeof rawDep.producer !== "string") {
      throw new EpicSetValidationError(
        400,
        "each dependency needs string consumer and producer endpoints (owner/repo#123 or an issue URL)",
      );
    }
    const consumer = resolveEndpoint(rawDep.consumer, "consumer");
    const producer = resolveEndpoint(rawDep.producer, "producer");
    if (consumer === producer) {
      throw new EpicSetValidationError(400, `epic ${consumer} cannot depend on itself`);
    }
    const pkg = (typeof rawDep.package === "string" ? rawDep.package : "").trim();
    const capabilityRef = (typeof rawDep.capabilityRef === "string" ? rawDep.capabilityRef : "").trim();
    if (pkg.length === 0) {
      throw new EpicSetValidationError(
        400,
        `dependency ${consumer} → ${producer} is missing a package (the producer's published package)`,
      );
    }
    if (capabilityRef.length === 0) {
      throw new EpicSetValidationError(
        400,
        `dependency ${consumer} → ${producer} is missing a capabilityRef (the producer's issue handle)`,
      );
    }
    const edgeId = `${consumer}\u0000${producer}`;
    if (seenEdges.has(edgeId)) continue; // duplicate edge in one submission → collapse (idempotent)
    seenEdges.add(edgeId);
    resolved.push({ consumer, producer, package: pkg, capabilityRef });
    const producers = adjacency.get(consumer) ?? new Set<string>();
    producers.add(producer);
    adjacency.set(consumer, producers);
  }

  assertAcyclic(adjacency);
  return resolved;
}

/** Depth-first cycle check over the consumer→producer graph. Throws {@link EpicSetValidationError}
 * (400) naming an edge on the cycle the moment one is found — the "reject at the offending edge"
 * guarantee. A pure in-memory walk (no I/O), so it runs before any admission side effect. */
function assertAcyclic(adjacency: Map<string, Set<string>>): void {
  const VISITING = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  const visit = (node: string, stack: string[]): void => {
    state.set(node, VISITING);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const s = state.get(next);
      if (s === VISITING) {
        throw new EpicSetValidationError(
          400,
          `dependency cycle detected: ${[...stack, next].join(" → ")} — the edge set must be a DAG`,
        );
      }
      if (s !== DONE) visit(next, stack);
    }
    stack.pop();
    state.set(node, DONE);
  };
  for (const node of adjacency.keys()) {
    if (state.get(node) !== DONE) visit(node, []);
  }
}

/** Optional scheduling inputs a planner (slice S3) threads into a plan-fanout instance at start.
 *
 * `readinessProbes` is the set of `capability` {@link ReadinessProbe} descriptors a DEPENDENT epic
 * must satisfy before it fans out any wave — one per inbound inter-epic edge (its producers). The
 * plan-fanout process runs them as a LEADING readiness-gate preflight (resources/processes/plan-fanout.bpmn):
 * a root epic (no inbound edge) is started with `undefined`/empty here and skips the gate entirely,
 * fanning out immediately exactly as a single epic does today. `probeTimeout` is the ISO-8601 bound
 * the preflight's timers fire off (derived once, via {@link readinessTimeout}, from the same probes)
 * so a never-publishing producer escalates in bounded time instead of wedging the dependent. */
export interface StartPlanOptions {
  readinessProbes?: ReadinessProbe[];
  probeTimeout?: string;
  probePollEvery?: string;
}

/** Register a plan row (if new) and start the plan-fanout process. Idempotent on
 * planKey: a plan already in flight is not restarted. */
export async function startPlan(
  data: DataLayer,
  engine: EngineClient,
  parsed: ParsedIssue,
  baseBranch: string,
  opts: StartPlanOptions = {},
) {
  // A gated dependent must carry BOTH its probes and the bound its preflight timers fire off:
  // `pr.readiness-probe` rejects a blank `probeTimeout` (worker.ts) and the preflight escalation
  // timers read `=probeTimeout`, so a non-empty probe set with a null/blank bound would incident at
  // runtime. Fail fast at the start door instead — the lowering (planLowering.ts) always derives the
  // two together via `readinessTimeout`, so this only fires for a mis-seeded direct caller.
  const probes = opts.readinessProbes && opts.readinessProbes.length > 0 ? opts.readinessProbes : null;
  if (probes && (opts.probeTimeout ?? "").trim() === "") {
    throw new Error(
      `startPlan(${parsed.planKey}): ${probes.length} readiness probe(s) seeded without a probeTimeout — ` +
        "the preflight escalation timers (=probeTimeout) and pr.readiness-probe both require a non-blank " +
        "bound. Derive it via readinessTimeout (see planLowering) before starting a gated dependent.",
    );
  }
  if (probes && (opts.probePollEvery ?? "").trim() === "") {
    throw new Error(
      `startPlan(${parsed.planKey}): ${probes.length} readiness probe(s) seeded without a probePollEvery — ` +
        "the preflight retry timers (=probePollEvery) require a non-blank cadence. Derive it via " +
        "readinessPollEvery (see planLowering) before starting a gated dependent.",
    );
  }
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
      // Capability-barrier bound (#289): the validated ISO-8601 duration read by the
      // `wait-caps-timeout` timer arm of the `wait-caps-resolved` event-based gateway. A task whose
      // declared cross-repo capabilities never resolve (most acutely an unresolvable capabilityRef the
      // host reconciler can never gate) escalates to the `feature-escalation` operator user task when
      // this elapses, instead of parking at the barrier forever — durable in-process liveness.
      capsWaitTimeout: CAPS_WAIT_TIMEOUT,
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
      // Inter-epic scheduling (issue #292, slice S3): the leading capability readiness-gate the
      // plan-fanout runs as a PREFLIGHT before wave 0. `readinessProbes` is a DEPENDENT epic's set
      // of `capability` probes (one per inbound `plan_deps` edge / producer); it is `null` for a
      // ROOT (no inbound edge), whose preflight gateway then routes straight past the gate so it
      // fans out immediately. `probeTimeout` bounds the preflight's escalation timers (derived once
      // from the same probes) so a never-publishing producer escalates without wedging the set.
      // `resolvedArtifacts` is filled by the preflight on green — the exact `pkg@version`s carrying
      // each awaited capability (one per probe, `null` for any that escalated). It rides the
      // implement task's `appendPrompt` (like `baseBranchBrief`) so slices build against exactly the
      // bound version. Seeded `null` here so a ROOT (which never runs the preflight) still resolves
      // the variable in that FEEL expression instead of raising an incident.
      readinessProbes: probes,
      probeTimeout: opts.probeTimeout ?? null,
      probePollEvery: opts.probePollEvery ?? null,
      // The preflight probe worker (`pr.readiness-probe`) requires a non-blank `gateKey` correlation
      // key (it publishes `readiness-ready` on it). The typed `ReadinessProbeIn` envelope projects it
      // from THIS process scope (not task-local ioMapping), so it is seeded here — one per dependent
      // instance. A ROOT never runs the preflight, so its `gateKey` stays `null`, unused.
      gateKey: probes ? `preflight:${parsed.planKey}` : null,
      resolvedArtifacts: null,
    },
  });
  const processKey = processInstanceKey == null ? null : String(processInstanceKey);
  if (processKey != null) {
    await table.update(parsed.planKey, { process_key: processKey, updated_at: now() });
  }
  return { planKey: parsed.planKey, processKey };
}

