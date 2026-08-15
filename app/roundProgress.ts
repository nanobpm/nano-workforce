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
 *  • `continue`  — request another review round (the head advanced, or the round carried an
 *                  explicit non-addressed status — e.g. `waiting` — that claims no push, or the
 *                  head could not be read so we fail OPEN rather than fabricate a no-progress
 *                  escalation).
 *  • `escalate`  — an `addressed` round whose PR head did not move: no commit was really pushed,
 *                  so re-review would loop. Escalate to a human instead of looping. */
export type ProgressRouting = "continue" | "escalate";

// The statuses that route AWAY from gw-status's `addressed`/default arm (see the explicit
// conditions on f_converged/f_waiting/f_escalate in convergence-loop.bpmn). A round carrying one of
// these legitimately claims no push and must always continue past the no-progress guard.
//
// Everything else — an explicit `addressed`, a blank/unknown/empty status, or any unrecognized
// string — takes gw-status's `addressed`/default arm, and pr.persist-round records a missing status
// as `addressed` too. That safe-default `addressed` round is EXACTLY the no-progress trap this guard
// exists for, so blank/unknown status must be treated as `addressed` here (subject to the head
// comparison), never waved through. Matching is exact (no trim) to mirror gw-status's `=status =
// "waiting"` equality: a padded `" waiting "` matches no arm there, so it defaults to `addressed`
// here as well.
const NON_ADDRESSED_STATUSES: ReadonlySet<string> = new Set([
  "waiting",
  "converged",
  "needs_input",
  "blocked",
]);

/** True when a round's status is `addressed` for no-progress purposes — i.e. NOT one of the
 * explicitly recognized non-addressed statuses. Blank/unknown/empty status is `addressed` here,
 * mirroring gw-status's default arm and pr.persist-round's missing-status default. The single
 * source of truth for both {@link routeProgress} and the pr.progress-check worker's early skip. */
export function isAddressedStatus(status: string | null | undefined): boolean {
  return !NON_ADDRESSED_STATUSES.has(status ?? "");
}

/** Decide whether a recorded round made real progress, exactly as `gw-progress` does.
 *
 * Only an `addressed` round claims the agent pushed changes, so only it can be a no-progress
 * round — and blank/unknown status counts as `addressed` (see {@link isAddressedStatus}): it is the
 * safe-default round this guard exists to catch. An explicitly recognized non-addressed status
 * (`waiting` on round 1, awaiting the first review, etc.) legitimately has no push and must always
 * continue. The check FAILS OPEN: when either head SHA is unknown — no GitHub transport, a transient
 * read error, or no baseline recorded yet (the first observed round) — we never fabricate a
 * no-progress escalation; we continue and let the round cap / review-wait timeout remain the safety
 * nets. */
export function routeProgress(
  status: string | null | undefined,
  previousHead: string | null | undefined,
  currentHead: string | null | undefined,
): ProgressRouting {
  if (!isAddressedStatus(status)) return "continue";
  if (!previousHead || !currentHead) return "continue";
  return currentHead === previousHead ? "escalate" : "continue";
}
