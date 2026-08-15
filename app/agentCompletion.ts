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
  "plan-review-decision",
  "trial-merge-decision",
  "wait-answer", // PR review-loop escalation (convergence-loop.bpmn, U3)
]);

/** Each escalation `elementId` → the `.form` whose contract governs its completion variables (the
 *  BPMN `zeebe:formDefinition formId`). Kept beside `ESCALATION_TASK_ELEMENTS` so the completer
 *  validates against the SAME `.form` the task inbox renders — one contract, no second field list. */
const ESCALATION_FORM_BY_ELEMENT: Readonly<Record<string, string>> = {
  "feature-escalation": "feature-escalation",
  "plan-review-decision": "plan-review-decision",
  "trial-merge-decision": "trial-merge-decision",
  "wait-answer": "pr-escalation",
};

interface FormContract {
  /** Field keys marked `validate.required` in the `.form`. */
  required: string[];
  /** `select` field key → its allowed `values`. */
  allowed: Record<string, string[]>;
}

const formContractCache = new Map<string, FormContract>();

/** Derive a `.form`'s required-field + select allowed-value contract, cached per formId. The `.form`
 *  files (`resources/forms/*.form`, deployed via nano.app.json) are the CANONICAL contract, so this
 *  reads them rather than re-encoding the field lists — no drift surface. */
function formContract(formId: string): FormContract {
  const cached = formContractCache.get(formId);
  if (cached) return cached;
  const raw: {
    components?: { key?: string; validate?: { required?: boolean }; values?: { value?: string }[] }[];
  } = JSON.parse(readFileSync(new URL(`../resources/forms/${formId}.form`, import.meta.url), "utf8"));
  const required: string[] = [];
  const allowed: Record<string, string[]> = {};
  for (const c of raw.components ?? []) {
    if (!c.key) continue;
    if (c.validate?.required) required.push(c.key);
    if (c.values?.length) {
      allowed[c.key] = c.values.map((v) => v.value ?? "").filter((v) => v !== "");
    }
  }
  const contract: FormContract = { required, allowed };
  formContractCache.set(formId, contract);
  return contract;
}

/** Validate completion `variables` against the escalation's `.form` contract (required fields present
 *  + `select` values within the allowed set), so a completion can never resume the process with a
 *  missing/invalid decision (e.g. a `wait-answer` with no `answer`, or a `trial-merge-decision` with
 *  an `action` outside proceed/rebase/abandon). Returns a human-readable reason on violation, or
 *  `null` when the variables satisfy the contract. Derived from the canonical `.form` — the same
 *  contract the task inbox renders — so both the agent and human completers reject invalid input the
 *  exact same way, with one implementation. An element with no linked form contract is not enforced. */
export function validateEscalationVariables(
  elementId: string,
  variables: Record<string, unknown>,
): string | null {
  const formId = ESCALATION_FORM_BY_ELEMENT[elementId];
  if (!formId) return null;
  const { required, allowed } = formContract(formId);
  for (const key of required) {
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

/** Resolve a parked escalation user task by key: return its `elementId` if it is one of the migrated
 *  escalation tasks, or a failure reason otherwise. Shared by the agent and human completers so both
 *  refuse a non-escalation / missing target the exact same way (a key with no matching open
 *  escalation task is a 404-style no-op). */
async function resolveEscalationTask(
  engine: EngineClient,
  userTaskKey: string,
): Promise<{ ok: true; elementId: string } | { ok: false; reason: string }> {
  const open = await engine.searchUserTasks();
  const match = open.find((t) => t.userTaskKey === userTaskKey);
  if (!match) return { ok: false, reason: "no open escalation task" };
  if (!match.elementId || !ESCALATION_TASK_ELEMENTS.has(match.elementId)) {
    return { ok: false, reason: "not an escalation task" };
  }
  return { ok: true, elementId: match.elementId };
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
 *  a 404-style no-op. */
export async function completeEscalationAsHuman(
  data: DataLayer,
  engine: EngineClient,
  input: { userTaskKey: string; variables: Record<string, unknown>; operatorId: string },
): Promise<AgentCompleteResult> {
  const userTaskKey = input.userTaskKey.trim();
  if (!userTaskKey) return { ok: false, reason: "userTaskKey is required" };
  const operatorId = input.operatorId.trim();
  if (!operatorId) return { ok: false, reason: "operatorId is required" };

  const resolved = await resolveEscalationTask(engine, userTaskKey);
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

/** The `feature-blocked` operator user-task element id (feature.bpmn). Unlike an escalation this is not
 *  an agent-answerable task — it is a blocked-run acknowledgement only a human operator retires — so it
 *  lives outside `ESCALATION_TASK_ELEMENTS` (the agent completer must never touch it) and has its own
 *  human-only completer below. */
export const FEATURE_BLOCKED_TASK_ELEMENT = "feature-blocked";

/** Complete the `feature-blocked` operator user task AS A HUMAN (issue #220). The blocked twin of
 *  `completeEscalationAsHuman`: it resolves the parked task by key, refuses anything that is not the
 *  `feature-blocked` task, and routes the operator's typed form variables (an optional `note`) through
 *  the SAME canonical `completeUserTaskAttributed` — so the nwf "Acknowledge blocked" affordance resumes
 *  the process (→ `pr.record-blocked-ack`, which settles the row to terminal `blocked`) through the one
 *  completion a human drives from the task inbox, recording WHO acknowledged in the `task_completions`
 *  ledger. A human completion is the authority (not reversible). A key with no matching open
 *  `feature-blocked` task is a 404-style no-op. */
export async function completeBlockedAsHuman(
  data: DataLayer,
  engine: EngineClient,
  input: { userTaskKey: string; variables: Record<string, unknown>; operatorId: string },
): Promise<AgentCompleteResult> {
  const userTaskKey = input.userTaskKey.trim();
  if (!userTaskKey) return { ok: false, reason: "userTaskKey is required" };
  const operatorId = input.operatorId.trim();
  if (!operatorId) return { ok: false, reason: "operatorId is required" };

  const open = await engine.searchUserTasks();
  const match = open.find((t) => t.userTaskKey === userTaskKey);
  if (!match) return { ok: false, reason: "no open blocked task" };
  if (match.elementId !== FEATURE_BLOCKED_TASK_ELEMENT) return { ok: false, reason: "not a blocked task" };

  const { completionId } = await completeUserTaskAttributed(
    data,
    engine,
    { userTaskKey, elementId: match.elementId, variables: input.variables },
    { kind: "human", id: operatorId },
  );
  return { ok: true, completionId, userTaskKey, elementId: match.elementId };
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
