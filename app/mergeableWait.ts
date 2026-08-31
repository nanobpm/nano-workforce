// Mergeable-wait liveness policy — kept as a pure module (no env, no I/O) so it is trivially
// testable, mirroring app/mergeLandedWait.ts. `app/service.ts` seeds the validated
// `mergeableWaitTimeout` process variable when it starts the merge-loop; the merge-loop's
// `wait-mergeable-timeout` timer catch (the timer arm of the `gw-merge-wait` event-based gateway,
// racing the poller's `merge-ready` message) evaluates its `<bpmn:timeDuration>=mergeableWaitTimeout`
// at timer creation (FEEL-expression timer durations, engine-native).
//
// This closes the mergeable-wait liveness gap (issue #636): `wait-mergeable` was the only long-lived
// wait in the merge loop with NO bounded-wait timer — a bare `intermediateCatchEvent` woken *solely*
// by the in-process poller's `merge-ready` message. If that poller stalls (dies across a redeploy,
// errors on a PR, or skips a verdict) the instance parks at `waiting_merge` forever, with no timeout
// and no escalation — the entire conflict/CI remediation machinery (`gw-mergeable` → rebase / CI-fix
// / escalate) sits downstream of `wait-mergeable`, so it is never entered. Bounding the wait with a
// timer arm makes that impossible: when the timeout elapses the token routes to `merge-stall-probe`,
// which re-derives ground-truth mergeability from GitHub and feeds the existing `gw-mergeable` arms
// (or, after the stall-round cap is exhausted, escalates to a human). It is a durable, in-process
// backstop — no external watchdog required — mirroring the convergence loop's `wait-review-timeout`
// and the merge loop's own `wait-landed-timeout`.

import { isoDuration } from "./reviewWait.ts";

/** Default mergeable-wait timeout (ISO-8601 duration): how long the merge loop waits for the poller
 * to publish `merge-ready` before the timer arm of the `gw-merge-wait` event-based gateway fires and
 * `merge-stall-probe` re-derives mergeability from ground truth. Deliberately short — a healthy
 * poller signals within one poll interval, so a 30-minute silence means the poller is dead and the
 * PR must be reconciled — while still generous enough not to fire against a merely-slow poll pass. */
export const DEFAULT_MERGEABLE_WAIT_TIMEOUT = "PT30M";

/** Validate the operator-supplied mergeable-wait timeout (env `NANO_PR_MERGEABLE_WAIT_TIMEOUT`,
 * ISO-8601 duration), falling back to {@link DEFAULT_MERGEABLE_WAIT_TIMEOUT} when absent, blank, or
 * malformed — a bad env value must never deploy an uninterpretable timer expression. Derives its
 * validation from the single canonical {@link isoDuration}. */
export function mergeableWaitTimeout(
  raw: string | undefined,
  def: string = DEFAULT_MERGEABLE_WAIT_TIMEOUT,
): string {
  return isoDuration(raw, def);
}
