// Merge-queue landing liveness policy — kept as a pure module (no env, no I/O) so it is trivially
// testable, mirroring app/agentSla.ts. `app/service.ts` seeds the validated `landedWaitTimeout`
// process variable when it starts the merge-loop; the merge-loop's `wait-landed-timeout` timer catch
// (the timer arm of the `eg-landed` event-based gateway, racing `merge-landed` / `merge-evicted`)
// evaluates its `<bpmn:timeDuration>=landedWaitTimeout` at timer creation (FEEL-expression timer
// durations, engine-native).
//
// This closes the merge-queue landing liveness gap (issue #556): `attempt-merge` classifies a merge
// as `queued` on an ambiguous "merge queue" signal (or a REST "accepted but not yet landed"
// fallback) WITHOUT verifying the PR was actually enqueued. On a repo where a plain `gh pr merge`
// does not enqueue (e.g. Mergify, which needs an explicit `@Mergifyio queue`), the PR is never
// placed in any queue, yet the loop parks at `wait-landed` awaiting a `merge-landed` that can never
// be published — ACTIVE, no incident, no escalation, forever. Bounding the wait with a timer arm
// makes that impossible: when the timeout elapses the token routes to the existing merge escalation
// so a human is pulled in (add it to the queue / merge it, then reply to retry). It is a durable,
// in-process backstop — no external watchdog required, mirroring the convergence loop's
// `wait-review-timeout`.

import { isoDuration } from "./reviewWait.ts";

/** Default merge-queue landing timeout (ISO-8601 duration): how long the merge loop waits for a
 * `queued` PR to actually land before the timer arm of the `eg-landed` event-based gateway fires and
 * it escalates to a human. Deliberately generous — a native GitHub merge queue legitimately takes a
 * while to build the prospective merged commit and run its required checks — while still bounded so a
 * never-enqueued PR (the Mergify-eligible-but-unqueued wedge, #556) surfaces to a human rather than
 * hanging forever. */
export const DEFAULT_MERGE_LANDED_WAIT_TIMEOUT = "PT1H";

/** Validate the operator-supplied merge-queue landing timeout (env
 * `NANO_PR_MERGE_LANDED_WAIT_TIMEOUT`, ISO-8601 duration), falling back to
 * {@link DEFAULT_MERGE_LANDED_WAIT_TIMEOUT} when absent, blank, or malformed — a bad env value must
 * never deploy an uninterpretable timer expression. Derives its validation from the single canonical
 * {@link isoDuration}. */
export function mergeLandedWaitTimeout(
  raw: string | undefined,
  def: string = DEFAULT_MERGE_LANDED_WAIT_TIMEOUT,
): string {
  return isoDuration(raw, def);
}
