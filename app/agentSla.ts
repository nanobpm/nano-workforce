// Agent-task liveness SLA policy — kept as a pure module (no env, no I/O) so it is trivially
// testable, mirroring app/escalationSla.ts. `app/service.ts` seeds the validated `agentSlaTimeout`
// process variable when it starts the merge-loop; the merge-loop's AGENT service tasks (rebase,
// fix-ci) carry an interrupting timer boundary whose `<bpmn:timeDuration>=agentSlaTimeout` evaluates
// it at timer creation (FEEL-expression timer durations, engine-native).
//
// This closes the agent-task liveness gap: unlike an escalation *user* task (whose SLA the
// escalationSla policy already bounds), an AGENT service task has no human in the loop — if no
// worker holds its capability, or the agent hangs/crashes without failing the job, the token parks
// on the task forever (no incident, no escalation). The boundary timer makes that impossible: when
// the SLA elapses the boundary fires, cancels the stuck job, and routes the token to the existing
// merge escalation so a human is pulled in. It is a durable, in-process backstop — no external
// watchdog required.

import { isoDuration } from "./reviewWait.ts";

/** Default agent-task SLA (ISO-8601 duration): how long a merge-loop agent service task (rebase /
 * fix-ci) may sit without completing before its interrupting timer boundary fires and the process
 * escalates for human attention. Deliberately much shorter than the human-decision escalation SLA
 * (PT24H): an agent that has not even started (unstaffed capability) or is stuck should surface to a
 * human quickly, while still being generous enough not to interrupt a legitimately long rebase. */
export const DEFAULT_AGENT_SLA_TIMEOUT = "PT2H";

/** Validate the operator-supplied agent SLA (env `NANO_PR_AGENT_SLA_TIMEOUT`, ISO-8601 duration),
 * falling back to {@link DEFAULT_AGENT_SLA_TIMEOUT} when absent, blank, or malformed — a bad env
 * value must never deploy an uninterpretable timer expression. Derives its validation from the
 * single canonical {@link isoDuration}. */
export function agentSlaTimeout(
  raw: string | undefined,
  def: string = DEFAULT_AGENT_SLA_TIMEOUT,
): string {
  return isoDuration(raw, def);
}
