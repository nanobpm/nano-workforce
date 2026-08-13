// Escalation-of-the-escalation SLA policy (epic #156, slice U5), kept as a pure module (no env, no
// I/O) so it is trivially testable — mirrors app/reviewWait.ts. `app/plan.ts` seeds the validated
// `escalationSlaTimeout` process variable at submit; the escalation user tasks in
// plan-fanout.bpmn carry an interrupting timer boundary whose `<bpmn:timeDuration>=escalationSlaTimeout`
// evaluates it at timer creation (FEEL-expression timer durations, engine-native).
//
// This models liveness IN the process: an escalation user task a human never answers can no longer
// hang forever — when the SLA elapses the boundary fires and the token auto-proceeds down each
// gateway's existing safe-default arm. It is the durable, in-process replacement for a poller-side
// watchdog: no external actor is required and forward progress is always possible.

import { isoDuration } from "./reviewWait.ts";

/** Default escalation SLA (ISO-8601 duration): how long an escalation user task may sit unanswered
 * before its timer boundary fires and the process auto-proceeds down the safe-default arm. A day is
 * generous for a human decision while still bounding the wait. */
export const DEFAULT_ESCALATION_SLA_TIMEOUT = "PT24H";

/** Validate the operator-supplied escalation SLA (env `NANO_ESCALATION_SLA_TIMEOUT`, ISO-8601
 * duration), falling back to {@link DEFAULT_ESCALATION_SLA_TIMEOUT} when absent, blank, or
 * malformed — a bad env value must never deploy an uninterpretable timer expression. Derives its
 * validation from the single canonical {@link isoDuration}. */
export function escalationSlaTimeout(
  raw: string | undefined,
  def: string = DEFAULT_ESCALATION_SLA_TIMEOUT,
): string {
  return isoDuration(raw, def);
}
