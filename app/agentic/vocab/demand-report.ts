// nano-workforce — the demand×supply report (epic #152 / N1 #145, ADR 0056 §8–10, ADR 0059 revised).
//
// The read-only mirror behind `GET /agentic/registry`. It diffs DEMAND — the routing tokens the
// deployed BPMN models ask for (`zeebe:taskDefinition` leaves, read from the engine's C8 v2 REST API
// via `@nanobpm/agentic/demand`) — against SUPPLY — the live workers on the H1 presence registry
// (#144), resolved through the crew vocab — to surface, per network: the demand×supply rows, the
// MISSING agent types (demanded leaf with no supplier → RED), and the diversity SLO over the
// correlated registry (ADR 0056 §10).
//
// Invariants (ADR 0056): app-tier only, advisory, NEVER a matchmaker — it reports what is demanded /
// supplied / missing and never places work or holds a seat's job. The C8 REST read is an ordinary
// read over a SEPARATE connection; the engine and the C8 job protocol stay frozen.
import {
  computeDemandSupply,
  type DemandSupplyReport,
  httpC8RestReader,
  readDeployedTaskDefinitions,
  type TaskDefinitionLeaf,
} from "@nanobpm/agentic/demand";
import type { RegisteredWorker } from "@nanobpm/agentic/vocab";
import type { Logger } from "@nanobpm/urban";
import type { RegistryReport as WireRegistryReport } from "../../../nano-generated/api-io.d.ts";
import { envVar } from "../../version.ts";
import { currentPresenceRegistry } from "../families/presence.family.ts";
import { CREW_VOCAB_VERSION, crewResolver } from "./crew-vocab.ts";

/** The full registry report: the package's demand×supply model plus this app's version/provenance. */
export interface RegistryReport extends DemandSupplyReport {
  /** The crew-vocab version the report was resolved against. */
  readonly version: number;
  /** When the report was computed, ISO-8601. */
  readonly generatedAt: string;
  /**
   * True when the demand side (deployed task definitions) could NOT be read from the engine, so the
   * report reflects supply only (empty demand). Surfaced — not hidden — so the board can flag that
   * demand is unavailable rather than silently showing "no demand".
   */
  readonly demandUnavailable: boolean;
}

/**
 * Derive the engine's C8 v2 REST base the demand reader targets — the same resolution `main.ts` uses:
 * an explicit `CAMUNDA_REST_ADDRESS` wins, else it is derived from `NANOBPMN_BASE_URL` (+ `/v2`),
 * defaulting to `http://localhost:8080/v2`. Read through the declared env schema (ADR 0004).
 */
export function engineRestAddress(): string {
  const explicit = envVar("CAMUNDA_REST_ADDRESS");
  if (explicit) return explicit;
  const base = (envVar("NANOBPMN_BASE_URL") ?? "http://localhost:8080").replace(/\/+$/, "");
  return `${base}/v2`;
}

/** The live supply rows (`{ instance, capability }`) from the H1 presence registry, or none when unmounted. */
export function supplyWorkers(): RegisteredWorker[] {
  return currentPresenceRegistry()?.registeredWorkers() ?? [];
}

/**
 * Read the deployed demand corpus (the models' `taskDefinition` leaves) from the engine over the C8
 * REST API. Returns `undefined` when the read fails so the caller can degrade to a supply-only
 * report rather than surface a hard error — the report is advisory and must never gate control flow.
 */
export async function readDemand(log?: Logger): Promise<TaskDefinitionLeaf[] | undefined> {
  try {
    const reader = httpC8RestReader({ restAddress: engineRestAddress(), token: envVar("CAMUNDA_TOKEN") ?? undefined });
    return await readDeployedTaskDefinitions(reader);
  } catch (err) {
    log?.warn("agentic registry: engine demand read failed — reporting supply only", { err: String(err) });
    return undefined;
  }
}

/** Inputs for {@link buildRegistryReport} (injectable so tests need no live engine or presence store). */
export interface BuildRegistryInput {
  /** The deployed demand leaves, or `undefined` when the engine read failed (supply-only report). */
  readonly taskDefinitions: readonly TaskDefinitionLeaf[] | undefined;
  /** The live supply rows. */
  readonly workers: readonly RegisteredWorker[];
  /** "Now" for `generatedAt`. Defaults to a fresh timestamp. */
  readonly now?: Date;
}

/**
 * Compute the registry report from demand + supply. Pure and deterministic (every list the package
 * emits is sorted), so it is safe to render straight into the board and diff frame-to-frame.
 */
export function buildRegistryReport(input: BuildRegistryInput): RegistryReport {
  const demandUnavailable = input.taskDefinitions === undefined;
  const report = computeDemandSupply({
    taskDefinitions: input.taskDefinitions ?? [],
    workers: input.workers,
    resolver: crewResolver(),
  });
  return {
    ...report,
    version: CREW_VOCAB_VERSION,
    generatedAt: (input.now ?? new Date()).toISOString(),
    demandUnavailable,
  };
}

/**
 * Project the (deeply-readonly) package report onto the mutable wire shape the OpenAPI response type
 * expects. A structural rebuild — never a cast — so a drift between the package model and the wire
 * schema is caught by the compiler here rather than silently coerced.
 */
export function toWireReport(report: RegistryReport): WireRegistryReport {
  return {
    version: report.version,
    generatedAt: report.generatedAt,
    demandUnavailable: report.demandUnavailable,
    networks: report.networks.map((network) => ({
      network: network.network,
      tokens: network.tokens.map((token) => ({
        token: token.token,
        supply: token.supply,
        instances: [...token.instances],
        satisfied: token.satisfied,
      })),
      missing: [...network.missing],
    })),
    missing: [...report.missing],
    nonAgentic: [...report.nonAgentic],
    diversity: {
      status: report.diversity.status,
      roles: report.diversity.roles.map((role) => ({
        token: role.token,
        seatsDistinctFamily: role.seatsDistinctFamily,
        assignments: role.assignments.map((seat) => {
          const out: WireRegistryReport["diversity"]["roles"][number]["assignments"][number] = {
            seat: seat.seat,
            family: seat.family,
          };
          if (seat.instance !== undefined) out.instance = seat.instance;
          return out;
        }),
        collidingFamilies: [...role.collidingFamilies],
        status: role.status,
      })),
    },
    status: report.status,
  };
}

/**
 * The composition path the `getAgenticRegistry` operation calls: read demand from the engine, read
 * supply from the presence registry, and build the report. Never throws for an engine outage — it
 * degrades to a supply-only report.
 */
export async function computeRegistryReport(log?: Logger): Promise<RegistryReport> {
  const taskDefinitions = await readDemand(log);
  return buildRegistryReport({ taskDefinitions, workers: supplyWorkers() });
}
