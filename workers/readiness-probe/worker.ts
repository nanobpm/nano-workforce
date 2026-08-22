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
const RESERVED_BIND_KEYS: ReadonlySet<string> = new Set(["ready", "detail"]);
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
  return {
    ready: false,
    detail: settled ? `gate boundary reached (fallback: ${settled.detail})` : "gate boundary reached",
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

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const probe = parseProbe(job.variables.probe);
  const { gateKey } = readGateVars(job.variables);
  const exec = defaultProbeExec();
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
  });
  return { ready: result.ready, detail: result.detail, ...safeBind(result.bind) };
};

export default handler;
