// Review-wait liveness policy, kept as a pure module (no env, no I/O) so it is trivially
// testable — mirrors app/rounds.ts. `service.ts` builds the fleet-wide REVIEW_WAIT_TIMEOUT and
// REVIEW_NUDGE_MS on top of these, and the process's timer catch is seeded with the validated
// ISO-8601 duration at submit.
//
// Two knobs govern the review-wait watchdog:
//   • the *timeout* — an ISO-8601 duration handed to the process's `wait-review-timeout` timer
//     catch (the far side of the event-based-gateway race against `review-ready`). If no fresh
//     review arrives within it, the loop escalates to a human instead of hanging forever.
//   • the *nudge cooldown* — how long the poller waits between automatic Copilot re-requests for
//     one waiting PR, so a re-request that Copilot dismisses is retried without hammering the API.

/** Default review-wait timeout (ISO-8601 duration): how long the loop waits for a fresh review
 * before the timer arm of the event-based gateway fires and it escalates to a human. */
export const DEFAULT_REVIEW_WAIT_TIMEOUT = "PT20M";

// A pragmatic ISO-8601 duration matcher: requires a leading `P`, at least one component, and a
// `T` before any time components (with at least one time component after it). Good enough to
// reject an obviously-malformed env value before it is baked into a timer expression the engine
// would fail to interpret; not a full grammar (we don't need fractional seconds here).
const ISO_DURATION = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/;

/** Validate an ISO-8601 duration for the review-wait timer, falling back to `def` when the value
 * is absent, blank, or malformed — a bad env value must never deploy an uninterpretable timer
 * expression into the process. Normalises to upper case (`pt20m` → `PT20M`). */
export function reviewWaitTimeout(
  raw: string | undefined,
  def: string = DEFAULT_REVIEW_WAIT_TIMEOUT,
): string {
  const s = (raw ?? "").trim().toUpperCase();
  return s !== "" && ISO_DURATION.test(s) ? s : def;
}

/** Default cooldown (minutes) between automatic Copilot re-request nudges for one waiting PR.
 * Kept comfortably below the review-wait timeout default so several nudges are attempted before
 * the loop escalates. */
export const DEFAULT_REVIEW_NUDGE_MINUTES = 5;

/** Upper bound on the nudge cooldown — a runaway value could park a genuinely-stalled PR for days
 * with no re-request. Mirrors the ceiling discipline in rounds.ts. */
export const MAX_REVIEW_NUDGE_MINUTES = 24 * 60;

/** Coerce the operator-supplied nudge cooldown (env `NANO_PR_REVIEW_NUDGE_MINUTES`, minutes) into
 * a sane positive integer. Absent / blank / non-numeric / zero / negative / NaN fall back to
 * `fallback`; values above the ceiling are clamped down (and so is an oversized `fallback`, so it
 * can never bypass the ceiling). */
export function clampNudgeMinutes(
  value: unknown,
  fallback: number = DEFAULT_REVIEW_NUDGE_MINUTES,
): number {
  const safeFallback = Number.isFinite(fallback)
    ? Math.min(Math.max(Math.trunc(fallback), 1), MAX_REVIEW_NUDGE_MINUTES)
    : DEFAULT_REVIEW_NUDGE_MINUTES;
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(n)) return safeFallback;
  const i = Math.trunc(n);
  if (i < 1) return safeFallback;
  return Math.min(i, MAX_REVIEW_NUDGE_MINUTES);
}
