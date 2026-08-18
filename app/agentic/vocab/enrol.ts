// nano-workforce — the enrolment resolver (epic #152 / N1 #145, ADR 0059 revised).
//
// The server side of the REGISTER → SERVE handshake, over the ADR 0059 REST door `POST
// /agentic/enrol`: a worker declares its enrolment `capability` (cognition / weight / family / host)
// and gets back the SERVE token set it may serve, the vocab version it was resolved against, and the
// liveness lease TTL. Resolution is a pure fold over the crew vocab (`@nanobpm/agentic/vocab`), so it
// is DETERMINISTIC and idempotent per (app, worker): the same capability always yields the same
// SERVE (ADR 0059 revised — enrolment is per-worker; a machine may run several differently-capable
// workers, each enrolling on its own).
//
// This is the HTTP half of the handshake (the ADR 0059 endpoint contract). The live WS SERVE stream
// rides the agentic channel's `register` family, which the H1 presence slice owns; this resolver is
// the shared, connection-agnostic core both can call.

import type { Capability } from "@nanobpm/agentic/protocol";
import type { Resolution } from "@nanobpm/agentic/vocab";
import { currentPresenceRegistry } from "../families/presence.family.ts";
import { CREW_VOCAB_VERSION, crewResolver } from "./crew-vocab.ts";

/**
 * The default liveness lease TTL (ms) handed back on enrol when no live presence registry is mounted
 * to source the real TTL from. A worker refreshes its lease with a heartbeat inside this window.
 */
export const DEFAULT_LEASE_TTL_MS = 30_000;

/** One matched role in an enrolment resolution — provenance for the worker and the cockpit. */
export interface EnrolledRole {
  /** The leaf routing token the role resolves to. */
  readonly token: string;
  /** The role's cognition weight, if declared. */
  readonly weight?: number;
  /** Whether the role opted into strict distinct-family seating (diversity SLO). */
  readonly seatsDistinctFamily: boolean;
}

/** The result of enrolling a declared capability against the crew vocab. */
export interface EnrolmentResult {
  /** The SERVE token set — sorted, de-duplicated leaf tokens the worker may serve. */
  readonly serve: readonly string[];
  /** The matched roles (sorted by token) the SERVE tokens came from. */
  readonly roles: readonly EnrolledRole[];
  /** The crew-vocab version the capability was resolved against. */
  readonly demandVersion: number;
  /** The liveness lease TTL in ms the worker must heartbeat within. */
  readonly leaseTtl: number;
}

/** The current liveness lease TTL — the live presence TTL when mounted, else {@link DEFAULT_LEASE_TTL_MS}. */
export function leaseTtlMs(): number {
  return currentPresenceRegistry()?.ttlMs ?? DEFAULT_LEASE_TTL_MS;
}

/**
 * Resolve a declared enrolment capability to its SERVE set. Pure and deterministic: the same
 * capability always yields the same result, so enrol is idempotent per worker.
 */
export function resolveEnrolment(capability: Capability): EnrolmentResult {
  const resolver = crewResolver();
  const resolution: Resolution = resolver.resolve(capability);
  const roles: EnrolledRole[] = resolution.roles
    .map((role) => {
      const out: EnrolledRole = { token: role.token, seatsDistinctFamily: role.seatsDistinctFamily };
      if (role.weight !== undefined) return { ...out, weight: role.weight };
      return out;
    })
    .sort((a, b) => a.token.localeCompare(b.token));
  const serve = [...new Set(resolution.tokens)].sort((a, b) => a.localeCompare(b));
  return {
    serve,
    roles,
    demandVersion: CREW_VOCAB_VERSION,
    leaseTtl: leaseTtlMs(),
  };
}
