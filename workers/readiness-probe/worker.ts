// pr.readiness-probe — the ReadinessProbe executor (ADR 0001 §2, issue #258).
//
// The service-task half of the durable wait-gate (`resources/processes/readiness-gate.bpmn`). It is
// handed a declared `ReadinessProbe` descriptor + a `gateKey` correlation key, and polls the probe
// with backoff until it goes green — at which point it publishes the `readiness-ready` message the
// gate's event-based gateway correlates, releasing the wait. It does NOT own the timeout: the gate's
// timer arm is the authoritative bound (a hung or forever-red probe is escalated by the engine, not
// by a poller-side sentinel — ADR 0001 §2 pinned decision 3). Because the probe only *reads*
// readiness, a worker restart simply re-activates this job and re-probes (idempotent / resumable).
//
// Secrets never appear in the descriptor, a process variable, or a log line: a credential is read at
// execution time from the typed env-contract (`credentialEnv` → `readEnv`) and the probe's
// target/output is redacted before logging (ADR 0004 pinned decision 2).
import type { AppJobHandler } from "@nanobpm/urban";
import { readEnvOr } from "../../app/contracts.ts";
import {
  DEFAULT_EVERY_MS,
  defaultProbeExec,
  nextDelay,
  normalizePoll,
  type ProbeExec,
  type ProbePoll,
  type ProbeResult,
  parseProbe,
  probeBudgetMs,
  probeOnce,
  type ReadinessProbe,
  redactTarget,
} from "../../app/readiness.ts";
import type { WorkerInputs, WorkerOutputs } from "../../nano-generated/worker-io.d.ts";

// Input/output typed off the model data envelopes (`ReadinessProbeIn` / `ReadinessProbeOut` in
// readiness-gate.bpmn), the single source of truth for this worker's wire contract (ADR 0040).
// `probe` is a `nano:reference` to the nested `ReadinessProbe` shape, so it derives to the descriptor.
type In = WorkerInputs["pr.readiness-probe"];
type Out = WorkerOutputs["pr.readiness-probe"];

/** The message the gate's event-based gateway correlates on `=gateKey` to release the wait. */
export const READINESS_READY_MESSAGE = "readiness-ready";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The effective poll cadence: the descriptor's values, with `everyMs` defaulting through the env
 * contract (`NANO_READINESS_POLL_EVERY_MS`) when the descriptor omits it, then the built-in
 * defaults/clamps in {@link normalizePoll}. Reads the env value from the injected `env` (not the
 * ambient `process.env`) so the loop is deterministic under test. */
function effectivePoll(
  poll: ProbePoll | undefined,
  env: Record<string, string | undefined>,
): ReturnType<typeof normalizePoll> {
  const envEvery = Number(readEnvOr("NANO_READINESS_POLL_EVERY_MS", String(DEFAULT_EVERY_MS), env));
  const everyMs = poll?.everyMs ?? (Number.isFinite(envEvery) && envEvery >= 1 ? envEvery : DEFAULT_EVERY_MS);
  return normalizePoll({ everyMs, timeoutMs: poll?.timeoutMs, backoff: poll?.backoff });
}

/** The core poll loop, factored out with injectable I/O + clock + publisher so it is unit-testable
 * without a network, a subprocess, or a real timer. Polls until ready (publishes, returns ready) or
 * the local budget is exhausted (returns not-ready — the engine timer then bounds the wait). */
export async function pollUntilReady(deps: {
  probe: ReadinessProbe;
  gateKey: string;
  probeTimeout?: string;
  exec: ProbeExec;
  env: Record<string, string | undefined>;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  publish: (detail: string) => Promise<void>;
  log?: (msg: string) => void;
}): Promise<ProbeResult> {
  const poll = effectivePoll(deps.probe.poll, deps.env);
  // The local budget is bound to the gate PER INSTANCE: it adopts the same seeded `probeTimeout`
  // process variable the gate's engine timers fire off (`=probeTimeout`), falling back to the env-
  // derived twin only when it's absent. Recomputing from the ambient env would let the worker go
  // silent while the engine timer is still waiting if the env changed after the instance was seeded.
  const deadline = deps.now() + probeBudgetMs(deps.probeTimeout, deps.probe, deps.env);
  const label = redactTarget(deps.probe);
  let attempt = 0;
  for (;;) {
    const res: ProbeResult = await probeOnce(deps.probe, deps.exec, deps.env).catch((err) => ({
      ready: false,
      // Never surface the raw error message: a fetch/subprocess error can embed the target URL
      // (with query tokens), command fragments, or other secrets. Log only the error class name.
      detail: `probe error: ${err instanceof Error ? err.name : "Error"}`,
    }));
    deps.log?.(`readiness probe ${label} attempt ${attempt + 1}: ${res.detail}`);
    if (res.ready) {
      await deps.publish(res.detail);
      return res;
    }
    attempt += 1;
    const wait = nextDelay(attempt, poll);
    if (deps.now() + wait >= deadline) {
      return { ready: false, detail: "probe budget exhausted; engine timer bounds the wait" };
    }
    await deps.wait(wait);
  }
}

/** Normalize the two required process variables the gate seeds, failing fast when either is unusable.
 *
 * Both are load-bearing for the worker↔gate binding, so a bad value must surface immediately rather
 * than silently degrade:
 *  • `gateKey` is returned **raw** (only validated on a trimmed view). The gate's message subscription
 *    binds `correlationKey="=gateKey"` — the *untrimmed* process variable — so the publish key must
 *    match it byte-for-byte. Trimming the key we publish on would desync a whitespace-seeded `gateKey`
 *    from the gate's subscription, leaving a green probe to release the wait only via the timeout arm.
 *  • `probeTimeout` is required by the typed input envelope and drives BOTH the gate's engine timers
 *    (`=probeTimeout`). A missing/blank value used to fall back silently to the env-derived twin,
 *    breaking the per-instance bound (and masking a mis-seeded instance until it escalates); fail fast
 *    instead and pass the raw string through so worker and engine share one seeded bound. */
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
  const { gateKey, probeTimeout } = readGateVars(job.variables);
  const result = await pollUntilReady({
    probe,
    gateKey,
    probeTimeout,
    exec: defaultProbeExec(),
    env: process.env,
    now: () => Date.now(),
    wait: sleep,
    publish: async (detail) => {
      await app.engine.publishMessage({
        name: READINESS_READY_MESSAGE,
        correlationKey: gateKey,
        variables: { ready: true, detail },
      });
    },
    log: (msg) => app.log.info(msg),
  });
  return { ready: result.ready, detail: result.detail };
};

export default handler;
