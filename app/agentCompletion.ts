// Attributed escalation completion (epic #156, slice U6; ADR 0046) — the SINGLE place an escalation
// user task is completed on the host side, so an AGENT assignee can answer the exact same `.form` a
// human would without forking a second lane or a second completion implementation.
//
// Every escalation the epic migrated (task, plan-review, trial-merge, PR review-loop) parks on a
// native `userTask` bearing a linked `.form`. Whoever holds the assignment completes it with the
// form's typed variables, and the engine resumes the process. This module wraps that one canonical
// primitive (`engine.completeUserTask`) with two cross-cutting concerns ADR 0046 requires of an
// agent-answerable escalation:
//
//   • Attribution — record WHO completed the task (an agent identity vs a human) and the exact
//     typed variables they submitted, in the `task_completions` ledger, so the audit trail can tell
//     an agent answer apart from a human one.
//   • Reversibility — a completed user task cannot be un-completed in the engine, so an AGENT answer
//     must not be a silent irreversible commit: it is recorded `reversible`, and a human can mark it
//     reverted/overridden (recording who + when). Host-side consumers read the ledger to see whether
//     the latest completion is still authoritative.
//
// Derivation over duplication: the human out-of-band answer paths (app/plan.ts) route through the
// SAME `completeUserTaskAttributed` (as `human`), so there is exactly one implementation of "complete
// an escalation user task" — the agent path is an extension of it, not a parallel copy.

import { readFileSync } from "node:fs";
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import { CONFORMANCE_ESCALATION_ELEMENT } from "./conformance.ts";
import { DELIVERY_HUMAN_ELEMENT, isDeliveryHumanElement } from "./deliveryHuman.ts";
import { ACP_PERMISSION_ELEMENT, EMPTY_PLAN_ELEMENT, READINESS_ESCALATION_ELEMENT, READINESS_ESCALATION_PF_ELEMENT } from "./userTasks.ts";

const now = () => new Date().toISOString();

/** Who completed an escalation user task. `agent` completions are reversible (a human may override);
 *  `human` completions are already the authority. */
export type ActorKind = "agent" | "human";

/** The completing identity: an agent (per ADR 0046) or a human operator. `id` is the audit handle
 *  (agent id / operator name). */
export interface Actor {
  kind: ActorKind;
  id: string;
}

/** One escalation user-task completion, recorded for attribution + reversibility. */
export interface TaskCompletion {
  id: number;
  user_task_key: string;
  process_instance_key: string | null;
  element_id: string | null;
  actor_kind: ActorKind;
  actor_id: string;
  /** The typed form variables submitted, as JSON — the same shape a human submits. */
  variables_json: string;
  /** 1 when a human may still override this completion (agent completions). */
  reversible: number;
  /** 1 once a human has reverted/overridden it. */
  reverted: number;
  reverted_by: string | null;
  /** The human's corrective guidance that overrides the agent answer (when supplied on revert). */
  reverted_note: string | null;
  reverted_at: string | null;
  created_at: string;
}

export const taskCompletions = (data: DataLayer) =>
  data.table<TaskCompletion>("task_completions", "id");

/** The escalation user-task `elementId`s an agent assignee may answer (the four kinds the epic
 *  migrated to `userTask` + `.form`). The agent completer refuses any other parked task, so the
 *  agent path is scoped to escalations — it can never complete an arbitrary internal user task. */
export const ESCALATION_TASK_ELEMENTS: ReadonlySet<string> = new Set([
  "feature-escalation",
  "escalation", // shared human-escalation cell (human-escalation.bpmn, ADR 0006 S4 #603/#633) — the same
  //              agent-answerable feature-escalation task, relocated into a callActivity child cell
  "plan-review-decision",
  "trial-merge-decision",
  "wait-answer", // PR review-loop escalation (convergence-loop.bpmn, U3)
  "wait-merge-answer", // PR merge-loop escalation (merge-loop.bpmn) — same native user-task path (#256)
  DELIVERY_HUMAN_ELEMENT, // delivery-graph `human` node (ADR 0005 S3) — a scheduled user task, answerable by a human OR an agent (ADR 0046)
]);

/** The `feature-blocked` operator user-task element id (feature.bpmn) — the native wait a run parks on
 *  when the agent reports a `blocked` outcome. Unlike an escalation it is NOT agent-answerable (only a
 *  human operator retires a blocked run), so it lives OUTSIDE `ESCALATION_TASK_ELEMENTS` — the agent
 *  completer (`completeEscalationAsAgent`) must never touch it — but it IS a human-completable decision
 *  on the Tasks inbox, so the HUMAN completer accepts it (issue #332 folded the bespoke
 *  `acknowledge-blocked` door onto the one canonical `complete-user-task` door). */
export const FEATURE_BLOCKED_TASK_ELEMENT = "feature-blocked";

/** The `conformance-escalation` operator user-task element id (retro.bpmn) — the native ack a retro
 *  run parks on when the spec-conformance audit finds the epic did NOT cleanly meet its spec (a
 *  reduced / not-verified slice, or an unraised deviation). Like `feature-blocked` it is a human-only
 *  acknowledgement (never agent-answerable), so it lives OUTSIDE `ESCALATION_TASK_ELEMENTS` and only
 *  the HUMAN completer accepts it (issue #216). Re-exported from the canonical
 *  `CONFORMANCE_ESCALATION_ELEMENT` (app/conformance.ts) — one source of truth, no drift surface. */
export const CONFORMANCE_ESCALATION_TASK_ELEMENT = CONFORMANCE_ESCALATION_ELEMENT;

/** The `empty-plan-escalation` operator user-task element id (plan-fanout.bpmn) — the native decision a
 *  plan-fanout run parks on when the planner emits an EMPTY plan. Like `feature-blocked` and
 *  `conformance-escalation` it is a HUMAN-only operator decision (never agent-answerable, or the fleet
 *  could silently auto-resolve the very "no work was produced" case a human must adjudicate), so it
 *  lives OUTSIDE `ESCALATION_TASK_ELEMENTS` and only the HUMAN completer accepts it (issues #623/#624).
 *  Re-exported from the canonical `EMPTY_PLAN_ELEMENT` (app/userTasks.ts) — one source of truth. */
export const EMPTY_PLAN_TASK_ELEMENT = EMPTY_PLAN_ELEMENT;

/** The readiness/preflight escalation user-task element ids (`readiness-escalation-pf` in feature.bpmn's
 *  readiness preflight + plan-fanout.bpmn's producer-capability preflight; `readiness-escalation` in
 *  readiness-gate.bpmn / wait-gate.bpmn). Like `feature-blocked`, `conformance-escalation` and
 *  `empty-plan-escalation` these are HUMAN-only decisions — an agent must never auto-answer a readiness
 *  gate (that would silently defeat the "is upstream actually ready?" adjudication the gate exists for),
 *  so they live OUTSIDE `ESCALATION_TASK_ELEMENTS` and only the HUMAN completer accepts them (issue
 *  #674). Re-exported from the canonical constants in app/userTasks.ts — one source of truth. */
export const READINESS_ESCALATION_PF_TASK_ELEMENT = READINESS_ESCALATION_PF_ELEMENT;
export const READINESS_ESCALATION_TASK_ELEMENT = READINESS_ESCALATION_ELEMENT;

/** The user-task `elementId`s a HUMAN operator may complete from the Tasks inbox via the one canonical
 *  `complete-user-task` door: every agent-answerable escalation PLUS the human-only `feature-blocked`
 *  and `conformance-escalation` acknowledgements, PLUS the advisory ACP permission prompt
 *  (`ACP_PERMISSION_ELEMENT`, issue #559) a bridged escalate-policy `session/request_permission` raises.
 *  The AGENT completer stays scoped to `ESCALATION_TASK_ELEMENTS` (none of these three), so widening the
 *  human surface never lets an agent retire a blocked run, a conformance review, or an agent-permission
 *  prompt. The permission element has no static `.form` (it is not a BPMN user task), so
 *  `validateEscalationVariables` leaves its Allow/Deny variables unenforced — the permission bridge
 *  translates them into a RESOLUTION frame (`app/agentic/permission-bridge.ts`). */
export const HUMAN_COMPLETABLE_ELEMENTS: ReadonlySet<string> = new Set([
  ...ESCALATION_TASK_ELEMENTS,
  FEATURE_BLOCKED_TASK_ELEMENT,
  CONFORMANCE_ESCALATION_TASK_ELEMENT,
  EMPTY_PLAN_TASK_ELEMENT,
  READINESS_ESCALATION_PF_TASK_ELEMENT,
  READINESS_ESCALATION_TASK_ELEMENT,
  ACP_PERMISSION_ELEMENT,
]);

/** Each escalation `elementId` → the `.form` whose contract governs its completion variables (the
 *  BPMN `zeebe:formDefinition formId`). Kept beside `ESCALATION_TASK_ELEMENTS` so the completer
 *  validates against the SAME `.form` the task inbox renders — one contract, no second field list. */
const ESCALATION_FORM_BY_ELEMENT: Readonly<Record<string, string>> = {
  "feature-escalation": "feature-escalation",
  "escalation": "feature-escalation", // shared human-escalation cell renders the SAME feature-escalation form (#603/#633)
  "plan-review-decision": "plan-review-decision",
  "trial-merge-decision": "trial-merge-decision",
  "wait-answer": "pr-escalation",
  "wait-merge-answer": "pr-escalation",
  "feature-blocked": "feature-blocked",
  [EMPTY_PLAN_TASK_ELEMENT]: "empty-plan-escalation",
  [CONFORMANCE_ESCALATION_TASK_ELEMENT]: "conformance-escalation",
  [READINESS_ESCALATION_PF_TASK_ELEMENT]: "readiness-escalation",
  [READINESS_ESCALATION_TASK_ELEMENT]: "readiness-escalation",
  // NOTE: the delivery-graph `human` node (`DELIVERY_HUMAN_ELEMENT`, ADR 0005 S3) is intentionally
  // ABSENT here. Unlike the fixed-form escalations above, ONE `delivery-human-task` element is DESIGNED
  // to render DIFFERENT forms per node (explicit → category → generic → agent-router, `app/deliveryHuman.ts`
  // `resolveHumanForm`) — the S4 runner selects one at activation; this S3 slice deploys the generic
  // form as the static default. Either way a single static required-field contract cannot fit it. Its typed-emit
  // contract is enforced instead by `bindHumanEmits` against the node's declared `emits[]` (binds are
  // validated, not stringly — Decision 3/4), so `validateEscalationVariables` leaves it unenforced
  // (returns `null`) and the completer accepts the captured form variables for the emit binder to type.
};

/** The fixed `.form` linkage (a `zeebe:formDefinition formId`) that governs a fixed-form escalation
 *  kind's completion, or `undefined` for a kind with no static form (the delivery-graph `human` node,
 *  which renders DIFFERENT forms per node — its `formKey` only ever comes from the engine at runtime).
 *  Exposed so the Tasks-inbox poller can denormalise a row's `form_key` from this SAME single source of
 *  truth when the raw `/v2/user-tasks/search` result omits the engine-resolved key (issue #461) — the
 *  REST gateway addresses a deployed form by value whether that value is a deploy key or an authored
 *  form id, so this id resolves the same deployed `.form` the completer validates against. */
export function escalationFormId(elementId: string): string | undefined {
  return ESCALATION_FORM_BY_ELEMENT[elementId];
}

/** A field's `conditional.hide` rule, parsed from the FEEL subset the `.form` files use
 *  (`=<ref> != "<value>"` / `=<ref> == "<value>"`). A required field is only enforced when it is
 *  actually shown, so an "answer only when resolution=answer" field is not demanded on the abandon
 *  path. */
interface HideRule {
  ref: string;
  op: "==" | "!=";
  value: string;
}

interface FormContract {
  /** Field keys marked `validate.required` in the `.form`. */
  required: string[];
  /** `select` field key → its allowed `values`. */
  allowed: Record<string, string[]>;
  /** Field key → its `conditional.hide` rule (only for fields whose visibility is conditional). */
  hideWhen: Record<string, HideRule>;
}

const formContractCache = new Map<string, FormContract>();

/** Parse the `.form` FEEL subset used by `conditional.hide` — `=<ref> (!=|==) "<value>"` — into a
 *  structured rule, or `null` for anything outside that subset (treated as "always shown", so a
 *  required field is never silently skipped by an unrecognised expression). */
function parseHide(expr: string | undefined): HideRule | null {
  if (!expr) return null;
  const m = /^=\s*([A-Za-z_$][\w$]*)\s*(==|!=)\s*"([^"]*)"\s*$/.exec(expr);
  if (!m) return null;
  const op = m[2] === "==" ? "==" : "!=";
  return { ref: m[1], op, value: m[3] };
}

/** Whether a `conditional.hide` rule hides its field given the submitted `variables`. */
function isHidden(rule: HideRule, variables: Record<string, unknown>): boolean {
  const actual = String(variables[rule.ref] ?? "");
  return rule.op === "!=" ? actual !== rule.value : actual === rule.value;
}

/** Derive a `.form`'s required-field + select allowed-value + conditional-visibility contract, cached
 *  per formId. The `.form` files (`resources/forms/*.form`, deployed via nano.app.json) are the
 *  CANONICAL contract, so this reads them rather than re-encoding the field lists — no drift surface. */
function formContract(formId: string): FormContract {
  const cached = formContractCache.get(formId);
  if (cached) return cached;
  const raw: {
    components?: {
      key?: string;
      validate?: { required?: boolean };
      values?: { value?: string }[];
      conditional?: { hide?: string };
    }[];
  } = JSON.parse(readFileSync(new URL(`../resources/forms/${formId}.form`, import.meta.url), "utf8"));
  const required: string[] = [];
  const allowed: Record<string, string[]> = {};
  const hideWhen: Record<string, HideRule> = {};
  for (const c of raw.components ?? []) {
    if (!c.key) continue;
    if (c.validate?.required) required.push(c.key);
    if (c.values?.length) {
      allowed[c.key] = c.values.map((v) => v.value ?? "").filter((v) => v !== "");
    }
    const hide = parseHide(c.conditional?.hide);
    if (hide) hideWhen[c.key] = hide;
  }
  const contract: FormContract = { required, allowed, hideWhen };
  formContractCache.set(formId, contract);
  return contract;
}

/** Validate completion `variables` against the escalation's `.form` contract (required fields present
 *  + `select` values within the allowed set), so a completion can never resume the process with a
 *  missing/invalid decision (e.g. a `wait-answer` with no `answer`, or a `trial-merge-decision` with
 *  an `action` outside proceed/rebase/abandon). A conditionally-shown required field is only enforced
 *  when its `conditional.hide` rule leaves it visible — so a `feature-escalation` with
 *  `resolution="answer"` demands a non-blank `answer` (re-dispatch guidance), but the `abandon` path,
 *  which hides `answer`, does not. Returns a human-readable reason on violation, or `null` when the
 *  variables satisfy the contract. Derived from the canonical `.form` — the same contract the task
 *  inbox renders — so both the agent and human completers reject invalid input the exact same way,
 *  with one implementation. An element with no linked form contract is not enforced. */
export function validateEscalationVariables(
  elementId: string,
  variables: Record<string, unknown>,
): string | null {
  const formId = ESCALATION_FORM_BY_ELEMENT[elementId];
  if (!formId) return null;
  const { required, allowed, hideWhen } = formContract(formId);
  for (const key of required) {
    const hide = hideWhen[key];
    if (hide && isHidden(hide, variables)) continue;
    const v = variables[key];
    if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
      return `${elementId}: "${key}" is required`;
    }
  }
  for (const [key, values] of Object.entries(allowed)) {
    const v = variables[key];
    if (v !== undefined && v !== null && !values.includes(String(v))) {
      return `${elementId}: "${key}" must be one of ${values.join(", ")}`;
    }
  }
  return null;
}

/** The canonical attributed completer. Records an attribution row in `task_completions` (reversible
 *  iff the actor is an agent) and THEN completes the user task with the exact typed `variables` — so
 *  the ledger row can never be lost by a resume that fires before the write. If the engine
 *  completion throws (a failed/rejected completion, or a lost race), the just-written row is rolled
 *  back so the ledger never claims a completion that did not happen, and the error is re-raised so
 *  the caller can retry. Returns the new completion id. This is the ONE host-side implementation of
 *  "complete an escalation user task"; both the agent path and the human out-of-band answer paths
 *  route through it. */
export async function completeUserTaskAttributed(
  data: DataLayer,
  engine: EngineClient,
  target: {
    userTaskKey: string;
    processInstanceKey?: string | null;
    elementId?: string | null;
    variables: Record<string, unknown>;
  },
  actor: Actor,
): Promise<{ completionId: number }> {
  // Normalize + validate the attribution keys upfront so the ledger can never record a row with
  // blank attribution or whitespace-mismatched keys.
  const userTaskKey = target.userTaskKey.trim();
  if (!userTaskKey) throw new Error("userTaskKey is required");
  const actorId = actor.id.trim();
  if (!actorId) throw new Error("actor id is required");

  const reversible = actor.kind === "agent";
  const id = await taskCompletions(data).insert({
    user_task_key: userTaskKey,
    process_instance_key: target.processInstanceKey ?? null,
    element_id: target.elementId ?? null,
    actor_kind: actor.kind,
    actor_id: actorId,
    variables_json: JSON.stringify(target.variables ?? {}),
    reversible: reversible ? 1 : 0,
    reverted: 0,
    reverted_by: null,
    reverted_note: null,
    reverted_at: null,
    created_at: now(),
  });
  const completionId = Number(id);
  try {
    await engine.completeUserTask(userTaskKey, target.variables);
  } catch (err) {
    // The completion did not take — roll the attribution row back so the ledger reflects only
    // completions that actually happened, and let the caller retry. The rollback is best-effort:
    // if the delete itself throws, the engine failure remains the primary signal we re-raise.
    try {
      await taskCompletions(data).delete(completionId);
    } catch {
      // swallow — never let a rollback failure mask the original engine error
    }
    throw err;
  }
  return { completionId };
}

/** The newest recorded completion for a user-task key, or undefined. */
export async function latestCompletion(
  data: DataLayer,
  userTaskKey: string,
): Promise<TaskCompletion | undefined> {
  const rows = await taskCompletions(data).find({ user_task_key: userTaskKey });
  let newest: TaskCompletion | undefined;
  for (const row of rows) {
    if (!newest || row.id > newest.id) newest = row;
  }
  return newest;
}

export interface AgentCompleteResult {
  ok: boolean;
  reason?: string;
  completionId?: number;
  userTaskKey?: string;
  elementId?: string;
}

/** Resolve a parked escalation user task by key: return its `elementId` if it is one of the `allowed`
 *  completable tasks, or a failure reason otherwise. Shared by the agent and human completers so both
 *  refuse a non-completable / missing target the exact same way (a key with no matching open task is a
 *  404-style no-op). The AGENT completer passes the default `ESCALATION_TASK_ELEMENTS`; the HUMAN
 *  completer passes the wider `HUMAN_COMPLETABLE_ELEMENTS` (which also admits `feature-blocked`).
 *  Queries `openUserTasks` (lifecycle-state `CREATED` only), NOT `searchUserTasks` (which returns
 *  tasks in ANY state) — a looping instance keeps COMPLETED/CANCELED tasks whose key could otherwise
 *  match and drive a doomed re-completion (a thrown 5xx) instead of the intended 404-style no-op. */
async function resolveEscalationTask(
  engine: EngineClient,
  userTaskKey: string,
  allowed: ReadonlySet<string> = ESCALATION_TASK_ELEMENTS,
): Promise<{ ok: true; elementId: string } | { ok: false; reason: string }> {
  const open = await engine.openUserTasks();
  const match = open.find((t) => t.userTaskKey === userTaskKey);
  if (!match) return { ok: false, reason: "no open completable task" };
  if (!match.elementId || !isCompletableElement(match.elementId, allowed)) {
    return { ok: false, reason: "not a completable task" };
  }
  return { ok: true, elementId: match.elementId };
}

/** Whether an open task's `elementId` is completable through the given `allowed` surface. Exact-set
 *  membership PLUS the delivery-human convention: any surface that admits the bare `DELIVERY_HUMAN_ELEMENT`
 *  (both `ESCALATION_TASK_ELEMENTS` and `HUMAN_COMPLETABLE_ELEMENTS` do) also admits the per-node inlined
 *  human tasks and their bounded-timeout escalation twins (`delivery-human-task__<el>[__esc]`) the S4
 *  compiler emits — matched through the single-source-of-truth `isDeliveryHumanElement` predicate so the
 *  routing can never drift from the compiler's id form (a human node is answerable by a human OR an
 *  agent, ADR 0046). */
function isCompletableElement(elementId: string, allowed: ReadonlySet<string>): boolean {
  if (allowed.has(elementId)) return true;
  return allowed.has(DELIVERY_HUMAN_ELEMENT) && isDeliveryHumanElement(elementId);
}

/** Complete an escalation user task AS AN AGENT (ADR 0046). Resolves the parked task by its key,
 *  refuses anything that is not one of the migrated escalation tasks, and routes the typed form
 *  variables through the shared attributed completer with the agent's identity. Reuses the exact
 *  form contract + resume path a human uses — no parallel completion. A key with no matching open
 *  escalation task is a 404-style no-op. */
export async function completeEscalationAsAgent(
  data: DataLayer,
  engine: EngineClient,
  input: { userTaskKey: string; variables: Record<string, unknown>; agentId: string },
): Promise<AgentCompleteResult> {
  const userTaskKey = input.userTaskKey.trim();
  if (!userTaskKey) return { ok: false, reason: "userTaskKey is required" };
  const agentId = input.agentId.trim();
  if (!agentId) return { ok: false, reason: "agentId is required" };

  const resolved = await resolveEscalationTask(engine, userTaskKey);
  if (!resolved.ok) return resolved;

  const invalid = validateEscalationVariables(resolved.elementId, input.variables);
  if (invalid) return { ok: false, reason: invalid };

  const { completionId } = await completeUserTaskAttributed(
    data,
    engine,
    { userTaskKey, elementId: resolved.elementId, variables: input.variables },
    { kind: "agent", id: agentId },
  );
  return { ok: true, completionId, userTaskKey, elementId: resolved.elementId };
}

/** Complete an escalation user task AS A HUMAN operator (issue #210). The exact twin of
 *  `completeEscalationAsAgent`, but attributed to a human: it drives the SAME canonical
 *  `completeUserTaskAttributed` with the operator's typed form variables, so the nwf UI's answer
 *  affordance resumes the process through the one implementation a human uses from the task inbox —
 *  no parallel completion path — while recording WHO answered in the `task_completions` ledger. A
 *  human completion is the authority (not reversible). A key with no matching open escalation task is
 *  a 404-style no-op. The human surface is the wider `HUMAN_COMPLETABLE_ELEMENTS`, so it also retires a
 *  `feature-blocked` acknowledgement (issue #332 folded the bespoke `acknowledge-blocked` door here). */
export async function completeEscalationAsHuman(
  data: DataLayer,
  engine: EngineClient,
  input: { userTaskKey: string; variables: Record<string, unknown>; operatorId: string },
): Promise<AgentCompleteResult> {
  const userTaskKey = input.userTaskKey.trim();
  if (!userTaskKey) return { ok: false, reason: "userTaskKey is required" };
  const operatorId = input.operatorId.trim();
  if (!operatorId) return { ok: false, reason: "operatorId is required" };

  const resolved = await resolveEscalationTask(engine, userTaskKey, HUMAN_COMPLETABLE_ELEMENTS);
  if (!resolved.ok) return resolved;

  const invalid = validateEscalationVariables(resolved.elementId, input.variables);
  if (invalid) return { ok: false, reason: invalid };

  const { completionId } = await completeUserTaskAttributed(
    data,
    engine,
    { userTaskKey, elementId: resolved.elementId, variables: input.variables },
    { kind: "human", id: operatorId },
  );
  return { ok: true, completionId, userTaskKey, elementId: resolved.elementId };
}

export interface RevertResult {
  ok: boolean;
  reason?: string;
  completionId?: number;
}

/** Revert/override an AGENT escalation completion (the reversibility guarantee of ADR 0046). A human
 *  marks a reversible, not-yet-reverted agent completion reverted, recording who did it, when, and
 *  optionally the corrective guidance that overrides the agent's answer — so the agent's answer is no
 *  longer treated as authoritative and the human correction is captured. Human completions are not
 *  reversible (they are already the authority), and a completion can only be reverted once. */
export async function revertAgentCompletion(
  data: DataLayer,
  completionId: number,
  reverter: Actor,
  note?: string,
): Promise<RevertResult> {
  const row = await taskCompletions(data).get(completionId);
  if (!row) return { ok: false, reason: "no such completion" };
  if (reverter.kind !== "human") return { ok: false, reason: "only a human may revert a completion" };
  if (!row.reversible) return { ok: false, reason: "completion is not reversible" };
  if (row.reverted) return { ok: false, reason: "completion already reverted" };
  const reverterId = reverter.id.trim();
  if (!reverterId) return { ok: false, reason: "reverter id is required" };

  const correction = typeof note === "string" ? note.trim() : "";
  await taskCompletions(data).update(completionId, {
    reverted: 1,
    reverted_by: reverterId,
    reverted_note: correction || null,
    reverted_at: now(),
  });
  return { ok: true, completionId };
}
