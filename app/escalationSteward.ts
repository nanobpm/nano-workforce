// Opt-in escalation steward (issue #889) — the domain core for the timer-driven loop that reviews
// OPEN escalations on OPTED-IN work and submits an agent's recommended choice for each, keeping the
// fleet moving while every automatic decision stays reviewable by a human after the fact.
//
// This module owns the PURE/host-side pieces so they are unit-testable without the engine:
//
//   • Eligibility — which open escalation user tasks the steward may touch: the task's owning work
//     must have OPTED IN (`auto_resolve_escalations` on its subject row), the escalation must be past
//     a short minimum age (so a human already answering wins), it must not be claimed by an in-flight
//     steward run (a claim/lease so overlapping ticks never double-answer), and it must be a kind the
//     steward is permitted to answer (never a human-only or irreversible-by-construction kind).
//   • The claim/lease fence — a durable compare-and-swap on `escalation_auto_resolutions` so two
//     overlapping steward ticks (or a steward tick racing a human) can never both act on one task.
//   • The record — one `escalation_auto_resolutions` row per escalation the steward resolved or
//     abstained from, so the Auto-resolutions view can render it and an operator can dismiss or
//     intervene.
//   • The loop guard + destructive-option abstention — pure functions the steward's collect step and
//     the agent's record step share, so the "never auto-answer an irreversible/credential choice" and
//     "stop re-answering a subject that keeps re-escalating" rules are enforced in ONE place.
//
// The engine-facing orchestration (the timer-start process, the collect/record service tasks, and the
// `senior:escalation-steward` agent job) lives in `resources/processes/escalation-steward.bpmn` and
// `workers/escalation-steward-*`; the actual ANSWER is submitted through the ONE canonical attributed
// door (`completeUserTaskAttributed`, app/agentCompletion.ts) with AGENT attribution — never recorded
// as a human decision (ADR 0046).
import type { DataLayer } from "@nanobpm/urban";
import { isUniqueConstraintFence } from "./dbFence.ts";
import type { UserTaskRow } from "./userTasks.ts";

/** The minimal shape of a subject row that carries the opt-in flag. The index signature lets the
 *  steward read each table's distinct PRIMARY-KEY column generically (see {@link optInBySubjectKey}). */
interface OptInSubjectRow {
  process_key: string | null;
  auto_resolve_escalations: number;
  [column: string]: string | number | null;
}

const now = () => new Date().toISOString();

/** Read a string field off a subject row by dynamic column name, returning `null` when it is absent
 *  or not a string. The row is widened to a string-indexed record via its own type (no `as` cast), so
 *  the generic per-table key read in {@link optInBySubjectKey} stays type-safe. */
function keyOf(row: OptInSubjectRow, column: string): string | null {
  const record: Record<string, unknown> = row;
  const v: unknown = record[column];
  return typeof v === "string" && v !== "" ? v : null;
}

/** The `senior:escalation-steward` agent's job type (the dispatch verb the steward process emits). */
export const ESCALATION_STEWARD_JOB_TYPE = "senior:escalation-steward";
/** The steward process definition id (`resources/processes/escalation-steward.bpmn`). */
export const ESCALATION_STEWARD_PROCESS_ID = "escalation-steward";

/** How long an escalation must be open before the steward considers it — a grace window so a human
 *  who is ALREADY answering wins and the steward never snatches a task out from under an operator.
 *  Configurable (`NANO_ESCALATION_STEWARD_MIN_AGE_MS`); default 5 minutes per the issue. */
export const DEFAULT_MIN_AGE_MS = 5 * 60 * 1000;

/** How many times a single subject may be auto-resolved before the steward abstains and leaves the
 *  re-escalation for a human — repeated escalation means the automatic answer isn't working. */
export const LOOP_GUARD_MAX_RESOLUTIONS = 2;

/** The escalation user-task `elementId`s the steward must NEVER auto-answer, because the decision is
 *  irreversible-by-construction, a credential/permission grant, or a gate whose whole point is a human
 *  judgement. These are refused BEFORE the agent is even dispatched (defence-in-depth under the
 *  prompt's own abstain rule), so the steward can never be the path that abandons work, approves a
 *  merge, grants a permission, or overrides a readiness gate.
 *
 *  This is deliberately a SUPERSET check independent of the agent-answerable `ESCALATION_TASK_ELEMENTS`
 *  set: an element is steward-eligible only if it is BOTH agent-answerable AND not in this guard set. */
export const STEWARD_NEVER_RESOLVE_ELEMENTS: ReadonlySet<string> = new Set([
  // Human-only merge approval (issue #826) — the fleet must never auto-approve a merge.
  "merge-approval",
  // ACP permission prompt (issue #559) — a credential/permission grant; always a human decision.
  "acp-permission",
  // Readiness/preflight gates (issue #674) — an agent must never auto-answer "is upstream ready?".
  "readiness-escalation",
  "readiness-escalation-pf",
  // Human-only terminal acknowledgements — a blocked run / a conformance shortfall / an empty plan are
  // exactly the "the automatic path produced nothing usable" cases a human must adjudicate.
  "feature-blocked",
  "conformance-escalation",
  "empty-plan-escalation",
]);

/** An `escalation_auto_resolutions` row — the durable, reviewable record of one steward action. */
export interface EscalationAutoResolution {
  id: number;
  user_task_key: string;
  escalation_kind: string | null;
  element_id: string | null;
  subject_type: string | null;
  subject_key: string | null;
  subject_url: string | null;
  process_instance_key: string | null;
  question: string | null;
  /** JSON array snapshot of the form's option values/labels at resolution time. */
  options: string | null;
  /** `resolved` (the steward submitted an answer) | `abstained` (it deliberately left it for a human).
   * `claimed` is the transient, non-final sentinel for an open claim/lease placeholder (never shown in
   * the review surface); the finalise step overwrites it to `resolved`/`abstained`. */
  outcome: "resolved" | "abstained" | "claimed";
  /** JSON of the variables submitted; NULL when abstained. */
  submitted_variables: string | null;
  rationale: string | null;
  /** JSON/markdown: what the agent checked, with links. */
  evidence: string | null;
  steward_instance_key: string | null;
  agent_job_key: string | null;
  worker: string | null;
  model: string | null;
  created_at: string;
  review_state: "pending" | "dismissed" | "intervened";
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  /** Claim/lease bookkeeping (not part of the review surface): which steward instance holds the claim
   *  and until when. NULL once the row is finalised (resolved/abstained recorded). */
  claimed_by: string | null;
  claimed_until: string | null;
}

export const escalationAutoResolutions = (data: DataLayer) =>
  data.table<EscalationAutoResolution>("escalation_auto_resolutions", "id");

/** Whether an escalation element kind is one the steward is permitted to answer at all. The agent
 *  prompt ALSO carries an abstain rule; this is the host-side fail-closed guard so a mis-prompted or
 *  misrouted steward can never touch a human-only / irreversible / credential kind. */
export function isStewardAnswerableElement(elementId: string): boolean {
  return !STEWARD_NEVER_RESOLVE_ELEMENTS.has(elementId);
}

/** Pure: is one open escalation user task ELIGIBLE for the steward right now? Requires:
 *   • the owning work opted in (`optedIn` — derived by the caller from the subject row);
 *   • the kind is steward-answerable ({@link isStewardAnswerableElement});
 *   • the task is past the minimum age (`minAgeMs`) so a human already answering wins;
 *   • the task is not currently claimed by a live steward run (`claimedUserTaskKeys`).
 * `at` is the current time (ms epoch); the task's `created_at` is its open-since timestamp. */
export function isEligibleEscalation(
  row: Pick<UserTaskRow, "user_task_key" | "element_id" | "created_at">,
  opts: { optedIn: boolean; minAgeMs: number; claimedUserTaskKeys: ReadonlySet<string>; at: number },
): boolean {
  if (!opts.optedIn) return false;
  if (!isStewardAnswerableElement(row.element_id)) return false;
  if (opts.claimedUserTaskKeys.has(row.user_task_key)) return false;
  const openedAt = Date.parse(row.created_at);
  if (Number.isNaN(openedAt)) return false;
  return opts.at - openedAt >= opts.minAgeMs;
}

/** Pure: the loop guard. Given the count of prior steward RESOLUTIONS for a subject, whether the
 *  steward must abstain on a fresh escalation for that same subject (it has already auto-answered
 *  `maxResolutions` times and the work escalated again — the automatic answer isn't working). */
export function loopGuardTripped(priorResolutions: number, maxResolutions: number = LOOP_GUARD_MAX_RESOLUTIONS): boolean {
  return priorResolutions >= maxResolutions;
}

/** Pure: does choosing this option abandon/destroy work or merge past a check — an IRREVERSIBLE or
 *  destructive choice the steward must abstain from even when the kind is otherwise answerable? The
 *  agent is instructed to abstain on these; this guard lets the host ALSO refuse to record a
 *  destructive resolution an agent erroneously submitted (fail-closed). Matched case-insensitively
 *  against the option value. */
const DESTRUCTIVE_OPTION_VALUES = /^(abandon|abandon-run|delete|destroy|discard|force-merge|merge-admin|override-checks?)$/i;
export function isDestructiveOption(optionValue: string): boolean {
  return DESTRUCTIVE_OPTION_VALUES.test(optionValue.trim());
}

/** The claim/lease TTL: a steward instance that crashes mid-run releases its claims after this long,
 *  so a later tick can pick the escalation up. Generous relative to the agent SLA. */
export const CLAIM_TTL_MS = 15 * 60 * 1000;

/** Atomically CLAIM a set of eligible escalation tasks for one steward run, so overlapping ticks never
 *  double-answer. For each task we insert a `pending`-outcome placeholder row keyed on `user_task_key`
 *  carrying the claim (`claimed_by`/`claimed_until`); the UNIQUE index on `user_task_key` among
 *  unresolved placeholder rows is the durable fence. A task already claimed (live lease) or already
 *  recorded is skipped. Returns the claimed rows (the subset this run may act on).
 *
 *  The fence is enforced by a partial UNIQUE index created in migration 120
 *  (`ux_auto_resolutions_open_claim` on `user_task_key` WHERE `outcome` IS the claim sentinel). The
 *  placeholder uses `outcome = 'claimed'` (a non-final sentinel distinct from `resolved`/`abstained`),
 *  which the finalise step overwrites. */
export async function claimEscalations(
  data: DataLayer,
  rows: UserTaskRow[],
  stewardInstanceKey: string,
  ttlMs: number = CLAIM_TTL_MS,
): Promise<EscalationAutoResolution[]> {
  const claimed: EscalationAutoResolution[] = [];
  const until = new Date(Date.now() + ttlMs).toISOString();
  // Drop any expired claims first so a crashed steward's leases don't wedge a task forever.
  await releaseExpiredClaims(data);
  for (const row of rows) {
    try {
      const id = await escalationAutoResolutions(data).insert({
        user_task_key: row.user_task_key,
        escalation_kind: row.kind_label,
        element_id: row.element_id,
        subject_type: row.subject_type,
        subject_key: row.subject_key,
        subject_url: row.subject_url,
        process_instance_key: row.process_key,
        question: row.question,
        options: null,
        outcome: "claimed",
        submitted_variables: null,
        rationale: null,
        evidence: null,
        steward_instance_key: stewardInstanceKey,
        agent_job_key: null,
        worker: null,
        model: null,
        created_at: now(),
        review_state: "pending",
        reviewed_by: null,
        reviewed_at: null,
        review_note: null,
        claimed_by: stewardInstanceKey,
        claimed_until: until,
      });
      const inserted = await escalationAutoResolutions(data).get(Number(id));
      if (inserted) claimed.push(inserted);
    } catch (err) {
      // A UNIQUE collision means another steward tick (or a racing claim) already holds this task —
      // skip it (the fence fired; that is the intended at-most-once outcome, not an error).
      if (isUniqueConstraintFence(err)) continue;
      throw err;
    }
  }
  return claimed;
}

/** Release claims whose lease has expired (a steward instance that crashed before finalising). */
export async function releaseExpiredClaims(data: DataLayer): Promise<number> {
  const res = await data.open().exec(
    `DELETE FROM "escalation_auto_resolutions" WHERE "outcome" = 'claimed' AND "claimed_until" IS NOT NULL AND "claimed_until" < ?`,
    [now()],
  );
  return res.changed;
}

/** Finalise a claim into a `resolved` or `abstained` record. Overwrites the placeholder row the claim
 *  created (matched by `user_task_key` + the `claimed` sentinel), so there is exactly ONE durable row
 *  per steward-acted escalation. */
export async function recordResolution(
  data: DataLayer,
  userTaskKey: string,
  patch: {
    outcome: "resolved" | "abstained";
    submittedVariables?: Record<string, unknown> | null;
    rationale?: string | null;
    evidence?: string | null;
    options?: unknown[] | null;
    agentJobKey?: string | null;
    worker?: string | null;
    model?: string | null;
  },
): Promise<void> {
  await data.open().exec(
    `UPDATE "escalation_auto_resolutions"
       SET "outcome" = ?, "submitted_variables" = ?, "rationale" = ?, "evidence" = ?, "options" = ?,
           "agent_job_key" = ?, "worker" = ?, "model" = ?, "claimed_by" = NULL, "claimed_until" = NULL
     WHERE "user_task_key" = ? AND "outcome" = 'claimed'`,
    [
      patch.outcome,
      patch.submittedVariables != null ? JSON.stringify(patch.submittedVariables) : null,
      patch.rationale ?? null,
      patch.evidence ?? null,
      patch.options != null ? JSON.stringify(patch.options) : null,
      patch.agentJobKey ?? null,
      patch.worker ?? null,
      patch.model ?? null,
      userTaskKey,
    ],
  );
}

/** Count a subject's prior steward RESOLUTIONS (for the loop guard). Only `resolved` rows count — an
 *  abstention did not apply an answer, so it must not trip the guard. */
export async function countSubjectResolutions(data: DataLayer, subjectKey: string): Promise<number> {
  const rows = await escalationAutoResolutions(data).find({ subject_key: subjectKey, outcome: "resolved" });
  return rows.length;
}

/** The set of `user_task_key`s currently claimed by a live steward run (unexpired, unfinalised). */
export async function liveClaimedTaskKeys(data: DataLayer): Promise<Set<string>> {
  const rows = await escalationAutoResolutions(data).find({ outcome: "claimed" });
  const out = new Set<string>();
  const at = now();
  for (const r of rows) {
    if (r.claimed_until != null && r.claimed_until >= at) out.add(r.user_task_key);
  }
  return out;
}

/** Mark a record dismissed (reviewed, no action) or intervened (operator stepped in), with an optional
 *  note. Only a FINAL (`resolved`/`abstained`), still-`pending` record transitions — an in-flight
 *  `claimed` placeholder starts life `review_state='pending'` too, so without the outcome guard a
 *  guessed/old claim id could be "reviewed" before it finalises, letting its eventual resolution slip
 *  past the pending-review queue (matching the list/read-model, which only ever surfaces final rows).
 *  An already-reviewed record is left alone (idempotent). */
export async function reviewResolution(
  data: DataLayer,
  id: number,
  action: "dismissed" | "intervened",
  reviewedBy: string,
  note: string | null,
): Promise<boolean> {
  const res = await data.open().exec(
    `UPDATE "escalation_auto_resolutions"
       SET "review_state" = ?, "reviewed_by" = ?, "reviewed_at" = ?, "review_note" = ?
     WHERE "id" = ? AND "review_state" = 'pending' AND "outcome" IN ('resolved', 'abstained')`,
    [action, reviewedBy, now(), note, id],
  );
  return res.changed === 1;
}

/** List auto-resolution records, newest first, optionally filtered by review state / subject / kind. */
export async function listAutoResolutions(
  data: DataLayer,
  filter: { reviewState?: string; subjectKey?: string; kind?: string } = {},
): Promise<EscalationAutoResolution[]> {
  let rows = await escalationAutoResolutions(data).all();
  // Only FINAL records are reviewable — an unfinalised `claimed` placeholder is an in-flight steward
  // action, not a reviewable decision, so it never reaches the view.
  rows = rows.filter((r) => r.outcome === "resolved" || r.outcome === "abstained");
  if (filter.reviewState) rows = rows.filter((r) => r.review_state === filter.reviewState);
  if (filter.subjectKey) rows = rows.filter((r) => r.subject_key === filter.subjectKey);
  if (filter.kind) rows = rows.filter((r) => r.escalation_kind === filter.kind || r.element_id === filter.kind);
  return rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
}

/** Count of PENDING (not-yet-reviewed) final records — the nav badge / list header. */
export async function pendingAutoResolutionCount(data: DataLayer): Promise<number> {
  return (await listAutoResolutions(data, { reviewState: "pending" })).length;
}

/** Build the `processInstanceKey` → opted-in map across EVERY escalation-raising subject table
 *  (`feature_runs`, `plans`, `pull_requests`, `delivery_graph_runs`). The steward's eligibility reads
 *  the flag off the SUBJECT row keyed by the escalation's owning instance — the durable source of
 *  truth, immune to an agent-completion clobber of the process variable (#887/#888). A subject whose
 *  row is absent, has no `process_key`, or carries `auto_resolve_escalations != 1` maps to NOT opted
 *  in (fail-closed: work that didn't opt in is never touched). */
export async function optInByProcessKey(data: DataLayer): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const collect = async (table: string, key: string) => {
    const rows: OptInSubjectRow[] = await data.table<OptInSubjectRow>(table, key).all();
    for (const r of rows) {
      if (r.process_key) out.set(String(r.process_key), r.auto_resolve_escalations === 1);
    }
  };
  await collect("feature_runs", "feature_key");
  await collect("plans", "plan_key");
  await collect("pull_requests", "pr_key");
  await collect("delivery_graph_runs", "run_key");
  return out;
}

/** The same opt-in derivation keyed by the SUBJECT's primary key (`feature_key`/`plan_key`/`pr_key`/
 *  `run_key`) rather than its engine `process_key`. The collect step needs BOTH: an escalation that
 *  parks INSIDE a callActivity child cell (the shared `human-escalation`/`implement-cell`, ADR 0006 S4)
 *  is denormalised onto `user_tasks` with the CHILD's `process_key` (which no subject row tracks) but
 *  the PARENT run's `subject_key` (which `pollUserTasks` correlates via the root instance, #603/#633).
 *  Resolving eligibility off the subject key lets those child-cell escalations opt in exactly as their
 *  owning run did, where a `process_key`-only lookup would always read them as non-opted-in. */
export async function optInBySubjectKey(data: DataLayer): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  // Each subject table's PRIMARY-KEY column differs, so read it generically: the row's key field is
  // the one named `key`. A missing/blank key is dropped (the `out.delete("")` below) so it never
  // matches a real escalation subject.
  const collect = async (table: string, key: string) => {
    const rows: OptInSubjectRow[] = await data.table<OptInSubjectRow>(table, key).all();
    for (const r of rows) {
      // Read the subject's primary-key column generically (it differs per table). `keyOf` is a type
      // guard, not an `as` cast, so the dynamic read stays type-safe.
      const keyValue = keyOf(r, key);
      out.set(keyValue ?? "", r.auto_resolve_escalations === 1);
    }
  };
  await collect("feature_runs", "feature_key");
  await collect("plans", "plan_key");
  await collect("pull_requests", "pr_key");
  await collect("delivery_graph_runs", "run_key");
  out.delete("");
  return out;
}
