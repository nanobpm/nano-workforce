// Long-poll wait on one run (issue #1057): `GET /run/wait?key=<key>&until=<cond>&timeout=<ISO>` holds the
// request until the run reaches `until`, then returns the SAME `RunView` `GET /run?key=` serves (issue
// #1054, app/runLookup.ts) — so an agent driving nwf neither re-polls `/status` (token cost) nor guesses
// a timer. The hold is server-side BOUNDED (`WAIT_MAX_MS`, under common proxy idle cuts): on expiry the
// body is `{ timedOut: true, view }` and the caller (d8ctl `nwf wait`) simply re-issues the request.
//
// Liveness rules (so a waiter can never miss what it must act on, nor hang on an unreachable state):
//   - an open escalation ALWAYS ends the wait (`reason: "escalated"`), whatever `until` asked for;
//   - a terminal run ALWAYS ends the wait (`reason: "terminal"`) — e.g. `until=merged` on a PR that was
//     closed unmerged can never hold, so holding until the timeout would only waste the caller's budget.
//
// Derivation over duplication: the view is `lookupRun`; terminality is the view's own `terminal` flag.
// The clock is injected so the loop is tested with a fake clock (no wall-clock sleeps in tests).

import { isoDurationToMs } from "./reviewWait.ts";
import type { RunView } from "./runLookup.ts";

export const WAIT_UNTIL = ["pr-opened", "converged", "merged", "escalated", "terminal", "any-change"] as const;
export type WaitUntil = (typeof WAIT_UNTIL)[number];

/** Server-side ceiling for ONE held request (25 min — below typical proxy/LB idle cuts of 30 min+). */
export const WAIT_MAX_MS = 25 * 60_000;
/** Default per-request hold when `timeout` is absent/malformed. */
export const WAIT_DEFAULT_TIMEOUT = "PT25M";
/** How often the held request re-reads the run (read-model only — cheap, no GitHub calls). */
export const WAIT_POLL_MS = 2_000;

export function parseWaitUntil(raw: unknown): WaitUntil | null {
  const s = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : "any-change";
  return WAIT_UNTIL.find((u) => u === s) ?? null;
}

/** The effective hold for one request: the requested ISO duration, clamped to `WAIT_MAX_MS`. A caller
 *  may ask for `PT2H`; it gets ≤ 25 min per request and loops (d8ctl does this for it). */
export function waitTimeoutMs(raw: unknown): number {
  const ms = isoDurationToMs(typeof raw === "string" ? raw : undefined, WAIT_DEFAULT_TIMEOUT);
  return Math.min(Math.max(ms, 0), WAIT_MAX_MS);
}

const SETTLED_PR = new Set(["converged", "merged"]);
const selfAndChildren = (v: RunView): RunView[] => [v, ...v.children];

/** A stable fingerprint of the observable run state, for `any-change` (ignores nothing but key order). */
export function runFingerprint(v: RunView): string {
  return JSON.stringify(v);
}

export type WaitReason = WaitUntil;

/** Does `view` satisfy the wait? Returns the reason it ended, or null to keep holding. Escalation and
 *  terminality end EVERY wait (see header). */
export function waitReason(until: WaitUntil, view: RunView, initialFingerprint: string): WaitReason | null {
  if (view.openEscalation || selfAndChildren(view).some((r) => r.openEscalation)) return "escalated";
  const runs = selfAndChildren(view);
  switch (until) {
    case "pr-opened":
      if (runs.some((r) => r.prUrl != null || r.kind === "pr")) return "pr-opened";
      break;
    case "converged":
      if (runs.some((r) => SETTLED_PR.has(r.status))) return "converged";
      break;
    case "merged":
      if (runs.some((r) => r.status === "merged")) return "merged";
      break;
    case "any-change":
      if (runFingerprint(view) !== initialFingerprint) return "any-change";
      break;
    default:
      break;
  }
  return view.terminal ? "terminal" : null;
}

export interface WaitClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: WaitClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export type WaitResult =
  | { found: false }
  | { found: true; timedOut: boolean; reason: WaitReason | null; until: WaitUntil; view: RunView };

/** Hold until `until` holds (or escalation/terminal), or `timeoutMs` elapses. `lookup` returns null for
 *  an unknown key (→ `found:false`, a 404). */
export async function waitForRun(
  lookup: () => Promise<RunView | null>,
  until: WaitUntil,
  timeoutMs: number,
  clock: WaitClock = realClock,
  pollMs: number = WAIT_POLL_MS,
): Promise<WaitResult> {
  const deadline = clock.now() + timeoutMs;
  let view = await lookup();
  if (!view) return { found: false };
  const initial = runFingerprint(view);
  for (;;) {
    const reason = waitReason(until, view, initial);
    if (reason) return { found: true, timedOut: false, reason, until, view };
    const left = deadline - clock.now();
    if (left <= 0) return { found: true, timedOut: true, reason: null, until, view };
    await clock.sleep(Math.min(pollMs, left));
    const next = await lookup();
    if (next) view = next;
  }
}
