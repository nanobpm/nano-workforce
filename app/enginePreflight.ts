// Engine address resolution + a lightweight, non-rejecting startup preflight
// (nano-workforce#391).
//
// Two jobs, one source of truth:
//   1. `resolveEngineAddress` is the CANONICAL resolver for the engine REST
//      address. Both the engine client (`main.ts`) and the demand reader
//      (`app/agentic/vocab/demand-report.ts`) derive from it, so the precedence
//      lives in exactly one place instead of drifting across call sites.
//   2. `announceEngine` probes `/v2/topology` at boot and reports which engine
//      answered. It is DELIBERATELY informational: Nano Workforce is a
//      first-class Camunda 8 client, so a non-Nano engine is announced, never
//      rejected. It never throws — a boot preflight must not gate startup.
//
// Why: without this, pointing the app at the wrong address (classically another
// service already on :8080) surfaces only later as a cryptic mid-run engine
// error. Echoing the resolved address + which engine answered makes the
// misconfiguration obvious at boot.

import { envVar } from "./version.ts";

/** The resolved engine REST address plus a human label for where it came from. */
export interface EngineAddress {
  /** The `/v2` REST base the engine client and demand reader talk to. */
  restAddress: string;
  /** Which input produced `restAddress`, for a legible startup line. */
  source: string;
}

/**
 * Canonical engine REST address resolution — the single source of truth.
 *
 * Precedence: an explicit `CAMUNDA_REST_ADDRESS` (already the `/v2` REST
 * address) wins; otherwise the address is derived from `NANOBPMN_BASE_URL`
 * (+ `/v2`), defaulting the base to `http://localhost:8080`. Trailing slashes
 * are stripped from both inputs.
 *
 * `read` is injectable so the resolution is testable without mutating
 * `process.env`; it defaults to the app's `envVar` (ADR 0004) accessor.
 */
export function resolveEngineAddress(
  read: (name: string) => string | null = envVar,
): EngineAddress {
  const explicit = read("CAMUNDA_REST_ADDRESS")?.replace(/\/+$/, "");
  if (explicit) return { restAddress: explicit, source: "CAMUNDA_REST_ADDRESS" };
  const base = read("NANOBPMN_BASE_URL");
  const normalized = (base ?? "http://localhost:8080").replace(/\/+$/, "");
  return {
    restAddress: `${normalized}/v2`,
    source: base ? "NANOBPMN_BASE_URL" : "default (http://localhost:8080)",
  };
}

/**
 * The subset of a `/v2/topology` body we read. A nanobpmn gateway advertises a
 * `nano` object (its own extension) so a single call distinguishes it from a
 * stock Camunda 8 gateway, which returns the same shape without it.
 */
export interface TopologyProbe {
  nano?: { engine?: string; version?: string; falconPath?: string } | null;
  gatewayVersion?: string;
}

/**
 * A human-readable identity line for whatever answered `/v2/topology`. Never
 * rejects: a Camunda 8 gateway (no `nano` marker) is a supported target, so it
 * is described, not refused.
 */
export function describeEngine(body: TopologyProbe | null | undefined): string {
  const nano = body?.nano;
  if (nano?.engine) {
    const version = nano.version ? ` v${nano.version}` : "";
    const falcon = nano.falconPath ?? "/falcon";
    return `Nano engine (${nano.engine}${version}) — Falcon streaming at ${falcon}`;
  }
  const gateway = body?.gatewayVersion ? ` (gateway v${body.gatewayVersion})` : "";
  return `Camunda 8${gateway} — REST only (Nano Falcon streaming unavailable)`;
}

/** The logging surface `announceEngine` needs (structurally a `Logger`). */
export interface PreflightLog {
  info(msg: string): void;
  warn(msg: string): void;
}

/**
 * Log the resolved engine address (and its source), then probe `/v2/topology`
 * and announce which engine answered. Informational only — it swallows every
 * failure into a `warn` and never throws, so a slow or absent engine cannot
 * block boot. A missing engine is a `warn` (features will fail to start until
 * it is reachable), not a fatal error.
 */
export async function announceEngine(
  addr: EngineAddress,
  log: PreflightLog,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  log.info(`Engine address: ${addr.restAddress} (from ${addr.source})`);
  const url = `${addr.restAddress.replace(/\/+$/, "")}/topology`;
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      log.warn(
        `Engine preflight: ${url} returned HTTP ${res.status}. ` +
          `Check CAMUNDA_REST_ADDRESS / NANOBPMN_BASE_URL — features will fail to start until the engine is reachable.`,
      );
      return;
    }
    const body: TopologyProbe = await res.json();
    log.info(`Engine: ${describeEngine(body)} at ${addr.restAddress}.`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(
      `Engine preflight: could not reach ${url} (${reason}). ` +
        `Check CAMUNDA_REST_ADDRESS / NANOBPMN_BASE_URL — features will fail to start until the engine is reachable.`,
    );
  }
}
