// Agent-task liveness SLA policy — kept as a pure module (the only I/O is the single canonical
// env read for the constant, through the ONE typed env schema) so it is trivially testable,
// mirroring app/escalationSla.ts. Every
// process start that hosts an external agent task seeds the validated `agentSlaTimeout` process
// variable (issue #849): `app/service.ts` for the convergence- and merge-loops, `app/feature.ts`
// for a single-issue feature run, `app/plan.ts` for the epic plan-fanout, `app/retro.ts` for the
// retrospective, and `app/deliveryRunner.ts` for a compiled delivery graph. Only a SUBSET of those
// tasks is currently bounded — the implement-cell, the merge-cell's trial-merge, the merge-loop's
// rebase / fix-ci, and retro's conformance / synthesize each carry an interrupting timer boundary
// whose `<bpmn:timeDuration>=agentSlaTimeout` evaluates the seeded variable at timer creation
// (FEEL-expression timer durations, engine-native). The convergence-loop and plan-fanout agent
// tasks are only PRE-SEEDED here — their boundaries are intentionally deferred to #868 (a
// bpmn-auto-layout back-edge routing limitation, #867), so seeding them now is preparation, not a
// claim of effective coverage.
//
// This closes the agent-task liveness gap: unlike an escalation *user* task (whose SLA the
// escalationSla policy already bounds), an AGENT service task has no human in the loop — if no
// worker holds its capability, or the agent hangs/crashes without failing the job, the token parks
// on the task forever (no incident, no escalation). The boundary timer makes that impossible: when
// the SLA elapses the boundary fires, cancels the stuck job, and routes the token to the existing
// escalation path so a human is pulled in. It is a durable, in-process backstop — no external
// watchdog required.

import { readEnv } from "./contracts.ts";
import { isoDuration } from "./reviewWait.ts";

/** Default agent-task SLA (ISO-8601 duration): how long an external agent service task may sit
 * without completing before its interrupting timer boundary fires and the process escalates for
 * human attention. Deliberately much shorter than the human-decision escalation SLA (PT24H): an
 * agent that has not even started (unstaffed capability) or is stuck should surface to a human
 * quickly, while still being generous enough not to interrupt a legitimately long task (e.g. an
 * implementation slice). */
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

/** The one canonical, validated agent-task SLA every process start seeds as `agentSlaTimeout`
 * (issue #849). Lives in this leaf module (not `app/service.ts`) so every seeder — service,
 * feature, plan, retro, deliveryRunner — imports it without an import cycle. Seeding is universal,
 * but only the bounded subset (implement-cell, merge-cell, merge-loop, retro) evaluates it via a
 * boundary timer today; convergence-loop / plan-fanout are pre-seeded for #868. The env key is read
 * through the ONE typed env schema (`readEnv` over the `NANO_PR_AGENT_SLA_TIMEOUT` registry entry,
 * AGENTS.md issue #227) — never `process.env` directly — so a synonym/typo is a compile-time error,
 * not a silent runtime fallback. */
export const AGENT_SLA_TIMEOUT = agentSlaTimeout(readEnv("NANO_PR_AGENT_SLA_TIMEOUT"));
