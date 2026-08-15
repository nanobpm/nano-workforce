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
// without a host, mirroring `deriveFeatureEscalationPatch`.
//
// Completion is NOT owned here — the page posts the typed form variables to the ONE canonical human
// completer (`completeEscalationAsHuman`, app/agentCompletion.ts) / the existing feature answer &
// acknowledge operations, the exact resume path the task inbox uses. This module only makes the open
// tasks visible; a completed task's row is removed on the next pass when the engine no longer reports
// it open.
import type { DataLayer } from "@nanobpm/urban";
import { FEATURE_BLOCKED_ELEMENT, FEATURE_ESCALATION_ELEMENT } from "./feature.ts";

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

/** One row per currently-open native user-task escalation, denormalised for the Tasks page. Keyed on
 *  the completable `user_task_key` (a task is open at most once). Present iff the engine reports the
 *  task open; `pollUserTasks` deletes it once the task is gone. */
export interface UserTaskRow {
  user_task_key: string;
  element_id: string;
  kind_label: string;
  subject_type: string;
  subject_key: string;
  subject_url: string | null;
  question: string | null;
  process_key: string | null;
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
};

/** The denormalised context the poller has resolved for an open escalation user task. */
export interface UserTaskContext {
  userTaskKey: string;
  elementId: string;
  subjectType: "feature" | "plan" | "pr";
  subjectKey: string;
  subjectUrl?: string | null;
  question?: string | null;
  processKey?: string | null;
}

/** Pure: turn one resolved open escalation task into its desired read-model row, or `null` when the
 *  element is not one of the surfaced escalation kinds (so a non-escalation user task is never listed)
 *  or the required keys are blank. `created_at`/`updated_at` default to now for a fresh row; the
 *  reconcile preserves the original `created_at` on an update. */
export function buildUserTaskRow(ctx: UserTaskContext, at: string = now()): UserTaskRow | null {
  const userTaskKey = ctx.userTaskKey.trim();
  const subjectKey = ctx.subjectKey.trim();
  const kindLabel = USER_TASK_KIND_LABELS[ctx.elementId];
  if (!userTaskKey || !subjectKey || !kindLabel) return null;
  const question = typeof ctx.question === "string" && ctx.question.trim() ? ctx.question.trim() : null;
  return {
    user_task_key: userTaskKey,
    element_id: ctx.elementId,
    kind_label: kindLabel,
    subject_type: ctx.subjectType,
    subject_key: subjectKey,
    subject_url: ctx.subjectUrl ?? null,
    question,
    process_key: ctx.processKey ?? null,
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
    a.subject_url === b.subject_url &&
    a.question === b.question &&
    a.process_key === b.process_key
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

// ── Audit-table accessors used by the poller to enrich the question text ──────────────────────────
// These read the denormalised question/findings each escalation kind already records, keyed by the
// subject, so the Tasks grid can show WHAT is being decided. They are display-only.

/** One implementation-phase / trial-merge escalation (006_task_escalation.sql, 014_plan_trial_merges).
 *  `status` is open | answered; the poller reads the OPEN row's `question`. */
export interface PlanEscalationRow {
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

export const planEscalations = (data: DataLayer) =>
  data.table<PlanEscalationRow>("plan_escalations", "id");

/** One plan-review cap escalation (020_plan_review_escalation.sql). `status` is open | answered; the
 *  poller reads the OPEN row's `findings` as the question. */
export interface PlanReviewEscalationRow {
  id: number;
  plan_key: string;
  epoch: number;
  round: number;
  findings: string | null;
  status: string;
  directive: string | null;
  note: string | null;
  asked_at: string;
  answered_at: string | null;
}

export const planReviewEscalations = (data: DataLayer) =>
  data.table<PlanReviewEscalationRow>("plan_review_escalations", "id");

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
