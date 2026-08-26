// Unified "Tasks" inbox read-model (issue #236) — the schema-driven pages' single source for the
// Tasks page, listing EVERY open native user-task escalation awaiting a human decision so an operator
// can resolve one in the nwf UI (Urban's `taskInbox` at /tasks is a read-only stub).
//
// The four migrated escalations (ADR 0046) are native `userTask`s with linked `.form`s. Their
// completable keys were only ever denormalised for the FEATURE kinds (migrations 031/032, onto
// `feature_runs`); the epic/PR kinds (`plan-review-decision`, `trial-merge-decision`, the PR
// `wait-answer`) had no app-side pointer, so the pages could not drive a completion. This module owns
// the `user_tasks` read-model row shape and the PURE derivation the `pollUserTasks` reconcile
// (app/service.ts) projects: `buildUserTaskRow` (one open task → a desired row) and
// `reconcileUserTasks` (the desired set vs the persisted set → the minimal upserts + deletes). The
// engine iteration + writes live in the poller; the decisions live here so they are unit-testable
// without a host.
//
// Completion is NOT owned here — the page posts the typed form variables to the ONE canonical human
// completer (`completeEscalationAsHuman`, app/agentCompletion.ts) via the `complete-user-task` door,
// the exact resume path the task inbox uses. This module only makes the open
// tasks visible; a completed task's row is removed on the next pass when the engine no longer reports
// it open.
import type { DataLayer } from "@nanobpm/urban";
import { CONFORMANCE_ESCALATION_ELEMENT } from "./conformance.ts";
import { DELIVERY_HUMAN_ELEMENT, isDeliveryHumanElement } from "./deliveryHuman.ts";
import { FEATURE_BLOCKED_ELEMENT, FEATURE_ESCALATION_ELEMENT, type FeatureEscalationRow } from "./feature.ts";
import type { PlanReview } from "./plan.ts";
import type { TrialMergeAuditRow } from "./trialMerge.ts";

const now = () => new Date().toISOString();

/** The plan-review cap escalation user task (plan-fanout.bpmn) — a human directive (proceed/revise)
 *  when the adversarial review loop exhausts its budget without approval. */
export const PLAN_REVIEW_ELEMENT = "plan-review-decision";

/** The trial-merge escalation user task (plan-fanout.bpmn) — a human decision (proceed/rebase/abandon)
 *  when a wave's trial merge comes back red. */
export const TRIAL_MERGE_ELEMENT = "trial-merge-decision";

/** The PR review-loop escalation user task (convergence-loop.bpmn) — a human answer that resumes the
 *  review loop and is handed to the next round. */
export const PR_WAIT_ANSWER_ELEMENT = "wait-answer";

/** The PR merge-loop escalation user task (merge-loop.bpmn) — a human answer that resumes the merge
 *  loop (re-arms the merge poller) when the PR can't be landed (not mergeable / merge blocked). The
 *  same native user-task path as the review loop's `wait-answer` (#256), answered through the one
 *  canonical `completeUserTask` door and surfaced in this same Tasks inbox. */
export const PR_WAIT_MERGE_ANSWER_ELEMENT = "wait-merge-answer";

/** The ACP permission-prompt escalation (issue #559, ADR 0056) — the Tasks-inbox kind a bridged
 *  `session/request_permission` surfaces under when an escalate-policy agent asks a human to Allow/Deny
 *  a proposed action. Unlike the other escalation elements this is NOT a BPMN user-task element; it is
 *  the advisory app-tier permission bridge's row kind, raised from a derived permission REQUEST and
 *  answered through the same canonical `completeEscalationAsHuman` door as every other escalation, with
 *  the operator's answer flowed back down the relay as a permission RESOLUTION. The bridge is OPT-IN per
 *  hire — a `yolo`-policy request never reaches this path (see `app/agentic/permission-bridge.ts`). */
export const ACP_PERMISSION_ELEMENT = "acp-permission";

/** One row per currently-open native user-task escalation, denormalised for the Tasks page. Keyed on
 *  the completable `user_task_key` (a task is open at most once). Present iff the engine reports the
 *  task open; `pollUserTasks` deletes it once the task is gone. */
export interface UserTaskRow {
  user_task_key: string;
  element_id: string;
  kind_label: string;
  subject_type: string;
  subject_key: string;
  /** The subject's human-readable title (`feature_runs`/`plans`/`pull_requests`.`title`), derived by
   *  `pollUserTasks` from the subject row keyed on `subject_key` and coalesced to `subject_key` at
   *  build time so the title-led grids never render a blank primary line (issue #308). */
  subject_title: string;
  subject_url: string | null;
  question: string | null;
  process_key: string | null;
  /** The engine `formKey` of the parked user task's engine-declared form, denormalised so the single
   *  collapsed Tasks grid can resolve and render the deployed `.form` per row (nano-ide#457). Derived in
   *  the poller from the `/v2/user-tasks/search` result, falling back to the fixed-form kinds' static
   *  `.form` linkage; NULL when neither resolves (the grid degrades to bare completion). */
  form_key: string | null;
  created_at: string;
  updated_at: string;
}

export const userTasks = (data: DataLayer) => data.table<UserTaskRow>("user_tasks", "user_task_key");

/** Human-readable label per escalation element. The set of keys is the closed set of user-task
 *  elements the Tasks inbox surfaces — an element absent from here is not an escalation and is
 *  ignored by `buildUserTaskRow`, so an arbitrary internal user task can never leak into the inbox. */
export const USER_TASK_KIND_LABELS: Readonly<Record<string, string>> = {
  [FEATURE_ESCALATION_ELEMENT]: "Feature escalation",
  [FEATURE_BLOCKED_ELEMENT]: "Blocked feature run",
  [PLAN_REVIEW_ELEMENT]: "Plan review",
  [TRIAL_MERGE_ELEMENT]: "Trial merge",
  [PR_WAIT_ANSWER_ELEMENT]: "PR review",
  [PR_WAIT_MERGE_ANSWER_ELEMENT]: "PR merge",
  [CONFORMANCE_ESCALATION_ELEMENT]: "Conformance review",
  [DELIVERY_HUMAN_ELEMENT]: "Delivery: human step",
  [ACP_PERMISSION_ELEMENT]: "Agent permission",
};

/** The Tasks-inbox label for an open user-task `elementId`, or `undefined` when the element is not a
 *  surfaced kind (so an arbitrary internal user task is never listed). Exact table lookup PLUS the
 *  delivery-human convention: the S4 compiler inlines each `human` node (and each service node's
 *  bounded-timeout escalation twin) with a per-node id `delivery-human-task__<el>[__esc]`, which a bare
 *  table lookup would miss — matched through the single-source-of-truth `isDeliveryHumanElement`
 *  predicate so every inlined human/escalation task surfaces under the one delivery-human label. */
export function userTaskKindLabel(elementId: string): string | undefined {
  return USER_TASK_KIND_LABELS[elementId] ?? (isDeliveryHumanElement(elementId) ? USER_TASK_KIND_LABELS[DELIVERY_HUMAN_ELEMENT] : undefined);
}

/** The denormalised context the poller has resolved for an open escalation user task. */
export interface UserTaskContext {
  userTaskKey: string;
  elementId: string;
  subjectType: "feature" | "plan" | "pr" | "delivery" | "agent";
  subjectKey: string;
  /** The subject's human-readable title from its own row (`feature_runs`/`plans`/`pull_requests`.
   *  `title`). Optional/blank tolerated — `buildUserTaskRow` coalesces it to `subjectKey` so the
   *  projected `subject_title` is never blank. */
  subjectTitle?: string | null;
  subjectUrl?: string | null;
  question?: string | null;
  processKey?: string | null;
  /** The engine-resolved `formKey` of the task's engine-declared form, as the poller read it from the
   *  `/v2/user-tasks/search` result (or the fixed-form fallback). Optional/blank tolerated —
   *  `buildUserTaskRow` normalises a blank to NULL. */
  formKey?: string | null;
}

/** Pure: turn one resolved open escalation task into its desired read-model row, or `null` when the
 *  element is not one of the surfaced escalation kinds (so a non-escalation user task is never listed)
 *  or the completable key is blank. `created_at`/`updated_at` default to now for a fresh row; the
 *  reconcile preserves the original `created_at` on an update.
 *
 *  Engine-first sweep (#358): a KNOWN-kind escalation is NOT dropped when no tracked subject row
 *  resolved a subject key for it (an orphaned/untracked instance — the reported 19153 case). The
 *  subject key falls back to a stable, non-blank value — the instance (`processKey`) if known, else the
 *  completable `userTaskKey` — so the row still renders and stays answerable. The blank-`userTaskKey`
 *  and unknown-kind guards below remain (the `USER_TASK_KIND_LABELS` gate keeps arbitrary internal user
 *  tasks out of the inbox). */
export function buildUserTaskRow(ctx: UserTaskContext, at: string = now()): UserTaskRow | null {
  const userTaskKey = ctx.userTaskKey.trim();
  const kindLabel = userTaskKindLabel(ctx.elementId);
  if (!userTaskKey || !kindLabel) return null;
  const subjectKey = ctx.subjectKey.trim() || (ctx.processKey ?? "").trim() || userTaskKey;
  const question = typeof ctx.question === "string" && ctx.question.trim() ? ctx.question.trim() : null;
  const subjectTitle = typeof ctx.subjectTitle === "string" && ctx.subjectTitle.trim() ? ctx.subjectTitle.trim() : subjectKey;
  const formKey = typeof ctx.formKey === "string" && ctx.formKey.trim() ? ctx.formKey.trim() : null;
  return {
    user_task_key: userTaskKey,
    element_id: ctx.elementId,
    kind_label: kindLabel,
    subject_type: ctx.subjectType,
    subject_key: subjectKey,
    subject_title: subjectTitle,
    subject_url: ctx.subjectUrl ?? null,
    question,
    process_key: ctx.processKey ?? null,
    form_key: formKey,
    created_at: at,
    updated_at: at,
  };
}

/** The minimal write plan a reconcile pass applies: rows to insert, rows to update in place (the
 *  task is still open but its denormalised context changed), and keys to delete (the task is gone). */
export interface UserTaskReconcile {
  inserts: UserTaskRow[];
  updates: UserTaskRow[];
  deletes: string[];
}

/** True when the persisted row already matches the freshly-derived one on every display field, so the
 *  reconcile can skip a no-op write (an update touches `updated_at`, which would otherwise churn the
 *  row on every pass). `created_at`/`updated_at` are intentionally excluded. */
function sameRow(a: UserTaskRow, b: UserTaskRow): boolean {
  return (
    a.element_id === b.element_id &&
    a.kind_label === b.kind_label &&
    a.subject_type === b.subject_type &&
    a.subject_key === b.subject_key &&
    a.subject_title === b.subject_title &&
    a.subject_url === b.subject_url &&
    a.question === b.question &&
    a.process_key === b.process_key &&
    a.form_key === b.form_key
  );
}

/** Pure source of truth for the `pollUserTasks` reconcile: diff the DESIRED open-task rows (derived
 *  from the engine this pass) against the PERSISTED rows, returning the minimal insert/update/delete
 *  plan. A desired row not yet persisted is an insert; a persisted row whose task is still desired but
 *  whose context drifted is an update (preserving its original `created_at`); a persisted row no longer
 *  desired is a delete (its task was completed — here, via the inbox, or out-of-band). Idempotent: a
 *  steady state with no drift yields empty lists, so the poller performs zero writes. */
export function reconcileUserTasks(persisted: UserTaskRow[], desired: UserTaskRow[]): UserTaskReconcile {
  const persistedByKey = new Map(persisted.map((r) => [r.user_task_key, r]));
  const desiredByKey = new Map(desired.map((r) => [r.user_task_key, r]));
  const inserts: UserTaskRow[] = [];
  const updates: UserTaskRow[] = [];
  const deletes: string[] = [];

  for (const row of desired) {
    const existing = persistedByKey.get(row.user_task_key);
    if (!existing) {
      inserts.push(row);
    } else if (!sameRow(existing, row)) {
      updates.push({ ...row, created_at: existing.created_at });
    }
  }
  for (const row of persisted) {
    if (!desiredByKey.has(row.user_task_key)) deletes.push(row.user_task_key);
  }
  return { inserts, updates, deletes };
}

// ── Audit-table accessors + derivations used by the poller to enrich the question text ────────────
// These read the question/findings each escalation kind already records in a SURVIVING audit table,
// keyed by the subject, so the Tasks grid can show WHAT is being decided. They are display-only.
//
// NB: the bespoke `plan_escalations` / `plan_review_escalations` mirror tables were retired in
// migration 027 (the CONTRACT phase of the native-userTask migration), so the enrichment is derived
// from the canonical append-only audit logs that DID survive — `plan_reviews` (the adversarial
// plan-review log) and `plan_trial_merges` (the D3 trial-merge gate log) — not from a dropped mirror.
// The PR-loop `escalations` audit table was deliberately KEPT by 027, so `prEscalations` still reads it.

/** Pure: the findings that drove the still-open `plan-review-decision` escalation — the latest
 *  adversarial plan-review round's critique. `plan_reviews` is append-only per (epoch, round); the
 *  parked escalation is the tail of the current epoch, so the latest round by (epoch, round) carries
 *  the rejecting findings the human is being asked to overrule. `null` when there is no round yet. */
export function latestPlanReviewFindings(reviews: readonly PlanReview[]): string | null {
  let latest: PlanReview | undefined;
  for (const r of reviews) {
    if (!latest || r.epoch > latest.epoch || (r.epoch === latest.epoch && r.round > latest.round)) latest = r;
  }
  return latest?.findings ?? null;
}

/** Pure: the summary that drove the still-open `trial-merge-decision` escalation — the newest
 *  UNRESOLVED red trial-merge attempt. `plan_trial_merges` is append-only and supersede-on-insert
 *  marks superseded rows `resolved = 1`, so the newest unresolved `suite-failed`/`merge-conflict` row
 *  (highest `id`) is the wave awaiting the human decision. `null` when none is open. */
export function latestTrialMergeQuestion(audits: readonly TrialMergeAuditRow[]): string | null {
  let latest: TrialMergeAuditRow | undefined;
  for (const a of audits) {
    if (a.resolved === 1) continue;
    if (a.result !== "suite-failed" && a.result !== "merge-conflict") continue;
    if (!latest || a.id > latest.id) latest = a;
  }
  return latest?.summary ?? null;
}

/** One PR review-loop escalation (001_init.sql `escalations`). `status` is open | answered; the poller
 *  reads the OPEN row's `question`. */
export interface PrEscalationRow {
  id: number;
  pr_key: string;
  round_no: number;
  kind: string;
  question: string;
  answer: string | null;
  status: string;
  asked_at: string;
  answered_at: string | null;
}

export const prEscalations = (data: DataLayer) =>
  data.table<PrEscalationRow>("escalations", "id");

/** Pure: the question for the still-open PR review-loop escalation. `escalations` is append-only and
 *  `id` is an AUTOINCREMENT PK, so when a PR has multiple `open` rows the newest (highest `id`) is the
 *  live one the human is being asked; a positional `[0]` from an unordered `find` could surface a stale
 *  row. `null` when there is no open escalation. */
export function latestOpenEscalationQuestion(rows: readonly PrEscalationRow[]): string | null {
  let latest: PrEscalationRow | undefined;
  for (const r of rows) {
    if (r.status !== "open") continue;
    if (!latest || r.id > latest.id) latest = r;
  }
  return latest?.question ?? null;
}

/** Pure: the question for the still-open `feature-escalation`, sourced from the append-only
 *  `feature_escalations` audit log (migration 048) — the feature analogue of `latestOpenEscalationQuestion`.
 *  `record-feature-escalation` appends one row per escalation entry, so the newest row (highest `id`) is
 *  the live question the operator is being asked; a run that escalated, was answered, then re-escalated
 *  with a fresh question is covered because the later entry has the higher `id`. `null` when the feature
 *  has no recorded escalation (the poller then falls back to the legacy `feature_runs` column). */
export function latestFeatureEscalationQuestion(rows: readonly FeatureEscalationRow[]): string | null {
  let latest: FeatureEscalationRow | undefined;
  for (const r of rows) {
    if (!latest || r.id > latest.id) latest = r;
  }
  return latest?.question ?? null;
}
