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

  const open = await engine.searchUserTasks();
  const match = open.find((t) => t.userTaskKey === userTaskKey);
  if (!match) return { ok: false, reason: "no open escalation task" };
  if (!match.elementId || !ESCALATION_TASK_ELEMENTS.has(match.elementId)) {
    return { ok: false, reason: "not an escalation task" };
  }

  const { completionId } = await completeUserTaskAttributed(
    data,
    engine,
    {
      userTaskKey,
      elementId: match.elementId,
      variables: input.variables,
    },
    { kind: "agent", id: agentId },
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
