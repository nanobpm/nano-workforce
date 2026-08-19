// Capability-barrier bounded-wait policy (issue #289), kept as a pure module (no env, no I/O) so it
// is trivially testable — mirrors app/escalationSla.ts and app/reviewWait.ts. `app/plan.ts` seeds the
// validated `capsWaitTimeout` process variable at submit; the `wait-caps-timeout` timer catch on the
// `wait-caps-resolved` event-based gateway in plan-fanout.bpmn evaluates it at timer creation
// (FEEL-expression timer durations, engine-native).
//
// This models liveness IN the process: a task parked at the `wait-caps-resolved` capability barrier
// can no longer hang forever when a declared cross-repo capability never resolves — most acutely when
// the handle names no `owner/repo` releases source (an `UnresolvableCapabilityRefError`), so the host
// reconciler can never start a readiness-gate and never publishes `caps-resolved`. When this bound
// elapses the event-based gateway's timer arm fires and the token routes to the existing
// `feature-escalation` operator user task — a bounded wait + operator escalation, not a poller-side
// watchdog and not a silent wedge.

import { isoDuration } from "./reviewWait.ts";

/** Default capability-barrier bound (ISO-8601 duration): how long a task may park at
 * `wait-caps-resolved` waiting for every declared cross-repo capability to ship before the timer arm
 * fires and the token escalates to an operator. A day is generous for a genuine cross-team dependency
 * to publish while still bounding the wait — and it decisively unwedges a permanently-unresolvable
 * capability handle, which would otherwise never resolve at all. */
export const DEFAULT_CAPS_WAIT_TIMEOUT = "P1D";

/** Validate the operator-supplied capability-barrier bound (env `NANO_CAPS_WAIT_TIMEOUT`, ISO-8601
 * duration), falling back to {@link DEFAULT_CAPS_WAIT_TIMEOUT} when absent, blank, or malformed — a
 * bad env value must never deploy an uninterpretable timer expression. Derives its validation from
 * the single canonical {@link isoDuration}. */
export function capsWaitTimeout(
  raw: string | undefined,
  def: string = DEFAULT_CAPS_WAIT_TIMEOUT,
): string {
  return isoDuration(raw, def);
}
