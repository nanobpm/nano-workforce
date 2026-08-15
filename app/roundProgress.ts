// No-progress guard routing — the canonical, testable mirror of the convergence-loop
// `gw-progress` exclusive gateway (see resources/processes/convergence-loop.bpmn and the
// structural guard in roundProgress.test.ts).
//
// The convergence loop trusts the agent's self-reported `addressed` status to trigger the next
// Copilot review round. But an agent can return `addressed` (or fall back to the safe `addressed`
// default) WITHOUT actually pushing a commit — nothing landed on the PR head. Copilot then
// re-reviews byte-identical code, produces the same comments, and the loop burns rounds making no
// progress until the round cap escalates. That is the trap.
//
// So a deterministic step (`pr.progress-check`, workers/progress-check/worker.ts) reads the PR's
// head SHA and compares it to the head observed at the previous round. When an `addressed` round's
// head did NOT advance, the process must NOT request another review round — it escalates to the
// human `wait-answer` task instead. This module is the single source of truth for that decision so
// the worker and the BPMN gateway can never drift apart.

/** Where a recorded round routes after the progress check:
 *  • `continue`  — request another review round (the head advanced, or the round was not an
 *                  `addressed` round that claims a push, or the head could not be read so we
 *                  fail OPEN rather than fabricate a no-progress escalation).
 *  • `escalate`  — an `addressed` round whose PR head did not move: no commit was really pushed,
 *                  so re-review would loop. Escalate to a human instead of looping. */
export type ProgressRouting = "continue" | "escalate";

/** Decide whether a recorded round made real progress, exactly as `gw-progress` does.
 *
 * Only an `addressed` round claims the agent pushed changes, so only it can be a no-progress
 * round. A `waiting` round (round 1, awaiting the first review) legitimately has no push and must
 * always continue. The check FAILS OPEN: when either head SHA is unknown — no GitHub transport,
 * a transient read error, or no baseline recorded yet (the first observed round) — we never
 * fabricate a no-progress escalation; we continue and let the round cap / review-wait timeout
 * remain the safety nets. */
export function routeProgress(
  status: string | null | undefined,
  previousHead: string | null | undefined,
  currentHead: string | null | undefined,
): ProgressRouting {
  if ((status ?? "") !== "addressed") return "continue";
  if (!previousHead || !currentHead) return "continue";
  return currentHead === previousHead ? "escalate" : "continue";
}
