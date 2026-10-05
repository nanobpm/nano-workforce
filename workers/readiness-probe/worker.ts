// pr.readiness-probe — the ReadinessProbe executor (ADR 0001 §2, issue #258).
//
// The service-task half of the durable wait-gate (`resources/processes/readiness-gate.bpmn`). Since
// #428, the worker performs exactly one probe per activation; retry cadence and timeout bounds live in
// BPMN timers owned by the deterministic engine. A green probe publishes the `readiness-ready` message
// the gate's event-based gateway correlates; a red probe returns not-ready and lets the model schedule
// the next activation or the final timeout path.
//
// Secrets never appear in the descriptor, a process variable, or a log line: a credential is read at
// execution time from the typed env-contract (`credentialEnv` → `readEnv`) and the probe's
// target/output is redacted before logging (ADR 0004 pinned decision 2).
import type { AppJobHandler } from "@nanobpm/urban";
import {
  defaultProbeExec,
  isFactRefTarget,
  makeCapabilityFallback,
  type ProbeExec,
  type ProbeResult,
  parseProbe,
  probeOnce,
  READINESS_READY_MESSAGE,
  type ReadinessProbe,
  redactTarget,
} from "../../app/readiness.ts";
import type { WorkerInputs, WorkerOutputs } from "../../nano-generated/worker-io.d.ts";

// Input/output typed off the model data envelopes (`ReadinessProbeIn` / `ReadinessProbeOut`), the
// single source of truth for this worker's wire contract (ADR 0040).
type In = WorkerInputs["pr.readiness-probe"];
type Out = WorkerOutputs["pr.readiness-probe"];

/** The message the gate's event-based gateway correlates on `=gateKey` to release the wait. */
export { READINESS_READY_MESSAGE };

/** The canonical gate-payload keys the matcher's `bind` must never override. `bind` is the
 * kind-agnostic emit primitive (#274 Gap B), but it flows from matcher output into both the
 * `readiness-ready` message variables and the worker output — so a matcher that binds `ready`/`detail`
 * could shadow the canonical payload and break the gate contract. */
const RESERVED_BIND_KEYS: ReadonlySet<string> = new Set(["ready", "detail", "observed"]);
export function safeBind(bind?: Record<string, string>): Record<string, string> {
  if (!bind) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(bind)) {
    if (!RESERVED_BIND_KEYS.has(k)) out[k] = v;
  }
  return out;
}

function errorDetail(err: unknown): string {
  return `probe error: ${err instanceof Error ? err.name : "Error"}`;
}

/** Fail-closed guard for an UNRESOLVED wait-gate target (issue #872). A `wait` node's probe `target`
 * is late-bound from an upstream emit: the compiler rewrites it to the observed value only when that
 * fact resolved to a non-null value, otherwise it leaves the authored `<node>.<fact>` reference (or a
 * blank/null) in place. A probe left with such an unresolved target MUST NOT pass through — a blank or
 * fact-ref target is not a real handle, so the gate is NOT satisfiable yet. Returning not-ready keeps
 * the gate parked so its bounded timeout escalates to a human, instead of either incident-ing inside
 * `parseProbe` (which throws on a blank/fact-ref literal) or — worse — silently treating the null
 * target as "ready". Returns `null` when the target is a usable literal (let `parseProbe` run). */
function unresolvedTargetDetail(rawProbe: unknown): string | null {
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
  const target = isRecord(rawProbe) ? rawProbe.target : undefined;
  if (typeof target !== "string" || target.trim() === "") return "wait gate: unresolved target (not ready)";
  if (isFactRefTarget(target)) return "wait gate: unresolved upstream fact (not ready)";
  return null;
}

/** Single activation of the readiness probe. The engine owns retry cadence and the timeout boundary;
 * this function performs one `probeOnce`, publishes only when ready, and optionally performs exactly
 * one empirical fallback on a model-marked last attempt. */
export async function probeSingleShot(deps: {
  probe: ReadinessProbe;
  exec: ProbeExec;
  env: Record<string, string | undefined>;
  publish: (detail: string, bind?: Record<string, string>) => Promise<void>;
  lastAttempt?: boolean;
  fallback?: () => Promise<ProbeResult | null>;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}): Promise<ProbeResult> {
  const label = redactTarget(deps.probe);
  const res: ProbeResult = await probeOnce(deps.probe, deps.exec, deps.env).catch((err) => ({
    ready: false,
    detail: errorDetail(err),
  }));
  deps.log?.(`readiness probe ${label}: ${res.detail}`);
  if (res.ready) {
    await deps.publish(res.detail, res.bind);
    return res;
  }
  if (deps.lastAttempt !== true) return res;

  const settled = deps.fallback
    ? await deps.fallback().catch((err) => {
        deps.log?.(`readiness probe ${label} fallback error: ${err instanceof Error ? err.name : "Error"}`);
        return null;
      })
    : null;
  if (settled?.ready) {
    deps.log?.(`readiness probe ${label} fallback: ${settled.detail}`);
    await deps.publish(settled.detail, settled.bind);
    return settled;
  }
  // Boundary last attempt and STILL not ready: this is the escalation trigger. Surface a structured
  // warn (issue #514 Defect A) carrying the probe's last detail + what it OBSERVED, so a false-negative
  // (a matching release was live but its provenance body was momentarily empty) is diagnosable from the
  // logs — not just a contextless "escalated". `observed` is diagnostic-only and secret-free.
  const failingDetail = settled ? `${res.detail} (fallback: ${settled.detail})` : res.detail;
  const observed = settled?.observed ?? res.observed;
  deps.warn?.(
    `readiness gate escalating ${label}: not ready at boundary — ${failingDetail}` +
      (observed ? `; observed: ${observed}` : ""),
  );
  // Return the actual failing probe detail (not a generic "gate boundary reached" string): downstream
  // the wait-gate seeds `probeDetail` and the escalation context FEEL from `detail`, so overwriting it
  // here would make the escalation non-diagnostic — the very defect this change fixes. The fact that the
  // boundary/timeout was reached is already communicated by the escalation context ("exceeded its SLA …
  // before its ReadinessProbe went green") and the structured WARN above.
  return {
    ready: false,
    detail: failingDetail,
    observed,
  };
}

/** Normalize the required process variables the gate seeds, failing fast when either is unusable. */
export function readGateVars(vars: { gateKey?: unknown; probeTimeout?: unknown }): {
  gateKey: string;
  probeTimeout: string;
} {
  const gateKey = String(vars.gateKey ?? "");
  if (gateKey.trim() === "") throw new Error("readiness-probe: 'gateKey' is required (blank correlation key)");
  const { probeTimeout } = vars;
  if (typeof probeTimeout !== "string" || probeTimeout.trim() === "")
    throw new Error("readiness-probe: 'probeTimeout' is required (per-instance timer bound)");
  return { gateKey, probeTimeout };
}

// ── Deterministic-exec test seam (issue #450) ───────────────────────────────────────────────────
// The probe's I/O runs through {@link defaultProbeExec} — a REAL `node:child_process` subprocess (for
// `command` probes) / `fetch` (for `http`). A real subprocess is real-time async work that spans
// multiple macrotasks, which the urban-testkit's *virtual-clock* `settle()`/`drain()` fixpoint cannot
// deterministically await: it can return before the probe publishes `readiness-ready`, so a gate-flow
// e2e races the subprocess (the same fire-and-forget-across-teardown hazard behind the testkit
// use-after-free, nano-ide#446). An e2e under the virtual clock injects a synchronous, in-memory
// `ProbeExec` here so the probe resolves *within* the drain fixpoint — no real spawn, no wall-clock
// race — while production leaves the override unset and uses `defaultProbeExec()`. Deliberately a
// process-scoped seam (not urban worker DI, which `bootTestApp` does not expose per-worker); the e2e
// sets it before creating instances and clears it in teardown so it can never leak into production.
let probeExecOverride: ProbeExec | undefined;

/** Test-only seam: inject a deterministic {@link ProbeExec} for e2es driven by the virtual clock, or
 *  pass `undefined` to restore the production {@link defaultProbeExec}. Never called in production.
 *  Returns the PREVIOUS override so a caller can narrowly scope its change with `try/finally`
 *  (restore the prior value rather than assuming production), keeping the seam safe even if the set
 *  and clear are not lexically paired. */
export function __setProbeExecForTest(exec: ProbeExec | undefined): ProbeExec | undefined {
  const previous = probeExecOverride;
  probeExecOverride = exec;
  return previous;
}

function resolveProbeExec(): ProbeExec {
  return probeExecOverride ?? defaultProbeExec();
}

const handler: AppJobHandler<In, Out> = async (job, app) => {
  // Fail closed on an unresolved late-bound target (issue #872): a null/blank/fact-ref target means the
  // upstream emit this gate waits on never resolved — the gate is not satisfiable, so stay parked (and
  // let the gate's bounded timeout escalate) rather than throw in parseProbe or pass a null target
  // through as if ready.
  const unresolved = unresolvedTargetDetail(job.variables.probe);
  if (unresolved !== null) {
    app.log.warn(`readiness gate not ready: ${unresolved}`);
    return { ready: false, detail: unresolved };
  }
  const probe = parseProbe(job.variables.probe);
  const { gateKey } = readGateVars(job.variables);
  const exec = resolveProbeExec();
  const result = await probeSingleShot({
    probe,
    exec,
    env: process.env,
    lastAttempt: job.variables.lastAttempt === true,
    fallback: makeCapabilityFallback(probe, exec, process.env),
    publish: async (detail, bind) => {
      await app.engine.publishMessage({
        name: READINESS_READY_MESSAGE,
        correlationKey: gateKey,
        variables: { ready: true, detail, ...safeBind(bind) },
      });
    },
    log: (msg) => app.log.info(msg),
    warn: (msg) => app.log.warn(msg),
  });
  return {
    ready: result.ready,
    detail: result.detail,
    ...(result.observed !== undefined ? { observed: result.observed } : {}),
    ...safeBind(result.bind),
  };
};

export default handler;
