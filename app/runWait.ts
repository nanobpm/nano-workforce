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

import { MERGE_STAGE_STATUSES } from "./deliveryStatuses.ts";
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

/** Converged-or-later: `converged`, `merged`, or any merge-stage status (with auto-merge, pr.finalize
 *  moves a converged PR straight into waiting_deps, so `converged` itself may never be observed). */
const SETTLED_PR = new Set(["converged", "merged", ...MERGE_STAGE_STATUSES]);
const selfAndChildren = (v: RunView): RunView[] => [v, ...v.children];

/** The MEANINGFUL state of one run: every field EXCEPT the volatile bookkeeping (lease/heartbeat
 *  `leaseUntil`, `activeWorker`, `updatedAt`) — excluded by omission, so a newly added view field
 *  (settings, a restarted engine instance, acknowledgment, …) is fingerprinted by default and a lease
 *  renewal on a running agent never ends an `any-change` wait. */
const meaningful = (v: RunView) => {
  const { activeWorker: _w, leaseUntil: _l, updatedAt: _u, children: _c, ...rest } = v;
  return rest;
};

/** A stable fingerprint of the meaningful run state (self + children), for `any-change`. */
export function runFingerprint(v: RunView): string {
  return JSON.stringify({ ...meaningful(v), children: v.children.map(meaningful) });
}

/** Does the run as a WHOLE satisfy a status predicate? Its own status, or — for a run with children —
 *  EVERY child (so an epic with one merged slice and one open slice is not yet "merged"). A planned run
 *  (epic) must also be COMPLETE: `children` lists only slices whose PR exists, so a slice still
 *  implementing is absent — fail closed unless every planned slice is visible. */
const wholeRun = (v: RunView, ok: (s: string) => boolean): boolean => {
  if (ok(v.status)) return true;
  if (v.children.length === 0) return false;
  if (v.plannedChildren !== null && v.children.length < v.plannedChildren) return false;
  return v.children.every((c) => ok(c.status));
};

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
      if (wholeRun(view, (s) => SETTLED_PR.has(s))) return "converged";
      break;
    case "merged":
      if (wholeRun(view, (s) => s === "merged")) return "merged";
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
