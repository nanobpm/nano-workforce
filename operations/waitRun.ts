// GET /app/api/run/wait?key=<key>&until=<cond>&timeout=<ISO> → operationId `waitRun` (issue #1057).
// `d8ctl nwf wait <key> --until=…`: long-poll ONE run until it reaches a state, bounded server-side
// (≤ 25 min per request); on expiry `{ timedOut: true, view }` and the caller re-issues. An open
// escalation or a terminal run always ends the wait. Logic in app/runWait.ts; view from app/runLookup.ts.
//
// Liveness of the HOLD itself: the request's abort signal (client disconnect) stops the waiter, and a
// global cap (`NANO_RUN_WAIT_MAX_WAITERS`) bounds concurrently held waits — beyond it a 429 with
// Retry-After, so a reconnecting client can never accumulate orphan pollers without bound.
// Known gap: the host does not yet propagate client disconnect into `req.signal` — tracked upstream as
// https://github.com/nanobpm/nano-ide/issues/633. Until it lands, the waiter cap + server-side timeout
// bound the cost of an abandoned hold.
import { readEnvOr } from "../app/contracts.ts";
import type { RunView } from "../app/runLookup.ts";
import { lookupRun } from "../app/runLookup.ts";
import {
  parseWaitUntil,
  realClock,
  WAIT_MAX_WAITERS_DEFAULT,
  WAIT_POLL_MS,
  WAIT_RETRY_AFTER_S,
  WAIT_UNTIL,
  type WaitClock,
  WaiterGate,
  waitForRun,
  waitTimeoutMs,
} from "../app/runWait.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";
const capFromEnv = Number.parseInt(readEnvOr("NANO_RUN_WAIT_MAX_WAITERS"), 10);
/** The process-wide waiter gate (one per app process). */
export const waiterGate = new WaiterGate(Number.isFinite(capFromEnv) ? capFromEnv : WAIT_MAX_WAITERS_DEFAULT);

/** The request's abort signal, when the host supplies one (a fetch `Request` does; read structurally). */
export function requestSignal(req: object): AbortSignal | undefined {
  const s: unknown = "signal" in req ? req.signal : undefined;
  return s instanceof AbortSignal ? s : undefined;
}

export interface WaitDeps {
  lookup: () => Promise<RunView | null>;
  gate: WaiterGate;
  signal?: AbortSignal;
  clock?: WaitClock;
  pollMs?: number;
}

/** The route body, with its collaborators injected (tested directly). */
export async function serveWait(key: string, query: { until?: unknown; timeout?: unknown }, deps: WaitDeps) {
  const until = parseWaitUntil(query.until);
  if (until === null) return { status: 400, body: { error: `until must be one of ${WAIT_UNTIL.join("|")}` } };
  if (key === "") return { status: 404, body: { error: "nwf has never tracked a run with key " } };
  const release = deps.gate.tryAcquire();
  if (!release) {
    return {
      status: 429,
      headers: { "retry-after": String(WAIT_RETRY_AFTER_S) },
      body: { error: `too many concurrent waits (cap ${deps.gate.cap}); retry after ${WAIT_RETRY_AFTER_S}s` },
    };
  }
  try {
    const res = await waitForRun(
      deps.lookup,
      until,
      waitTimeoutMs(query.timeout),
      deps.clock ?? realClock,
      deps.pollMs ?? WAIT_POLL_MS,
      deps.signal,
    );
    if (!res.found) return { status: 404, body: { error: `nwf has never tracked a run with key ${key}` } };
    if (res.view === null) {
      return { status: 504, body: { error: `run lookup for ${key} did not complete before the wait deadline` } };
    }
    return { status: 200, body: { timedOut: res.timedOut, reason: res.reason, until: res.until, view: res.view } };
  } finally {
    release();
  }
}

export default defineOperation("waitRun", async ({ req, query }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("waitRun rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  const key = typeof query.key === "string" ? query.key.trim() : "";
  return serveWait(key, query, {
    lookup: () => lookupRun(app.data, app.engine, key),
    gate: waiterGate,
    signal: requestSignal(req),
  });
});
