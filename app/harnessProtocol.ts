// nano-workforce — the harness-protocol ENROLMENT GATE (issue #802).
//
// A stale worker harness — a `c8ctl-nano` build predating the AgentInstance-minting + transcript-flush
// + result-envelope path — silently services jobs and swallows every machine-readable artifact, so
// good agent work is lost to the orchestration and every run it touches dead-ends at a human
// (#796/#801). Job routing was BLIND to harness capability/version: enrolment advertised
// family/host/cognition/weight/durableResume but NOT a harness protocol version, so a stale harness
// won job leases indistinguishably from a healthy one.
//
// This module makes harness staleness OBSERVABLE and GATEABLE. It records, per worker instance, the
// protocol version the harness advertised at enrolment (a WORKER ATTRIBUTE — ADR 0056 §7, capability
// gates enrolment and is NEVER a routing token `network.role#seat`), and derives whether a worker is
// stale (below the minimum protocol, or advertising no version at all). The minimum protocol and the
// enforcement policy (flag-only vs refuse-routing) are declared env-contract knobs (app/contracts.ts).
//
// Advisory + app-tier only (ADR 0056): the registry NEVER hard-locks a BPMN sequence flow. The one
// place it may WITHHOLD is the SERVE-token resolution at enrol under the `refuse` policy — a stale
// harness is handed an empty SERVE set so it wins no job leases — which is a REGISTER→SERVE gate, not
// an engine/job-protocol change.
import type { DataLayer } from "@nanobpm/urban";
import { readEnvOr } from "./contracts.ts";

/**
 * The canonical name of the harness-protocol enrolment attribute. A worker advertises it at enrol; the
 * registry records it here. It is an ENROLMENT gate (ADR 0056 §7), never a routing token.
 */
export const HARNESS_PROTOCOL_ATTR = "harness-protocol";

/** The default minimum harness protocol when {@link NANO_AGENTIC_MIN_HARNESS_PROTOCOL} is unset. Kept
 * in the ONE registry entry (app/contracts.ts) — this literal only documents it for the reader. */
const DEFAULT_MIN_HARNESS_PROTOCOL = 1;

/** The staleness-enforcement policy: `flag` only marks a stale worker (observability); `refuse` also
 * withholds its SERVE tokens at enrol so it wins no job leases. */
export type StaleHarnessPolicy = "flag" | "refuse";

/** The default enforcement policy — `flag`, so a fleet whose harnesses have not yet been upgraded is
 * made VISIBLE but not abruptly drained. An operator opts into `refuse` to hard-gate routing. */
const DEFAULT_STALE_HARNESS_POLICY: StaleHarnessPolicy = "flag";

/** The durable table backing {@link HarnessProtocolRegistry} (`db/migrations/107_worker_harness_protocol.sql`).
 * The ONE source of truth for the name so the `Table<T>` gateway and the bounded batch read below can
 * never drift. */
const HARNESS_PROTOCOL_TABLE = "worker_harness_protocol";

/** Max bound host-parameters per `WHERE instance IN (…)` batch in {@link HarnessProtocolRegistry.protocolsFor}.
 * SQLite caps the number of host parameters per statement (`SQLITE_MAX_VARIABLE_NUMBER` — historically
 * 999, and still that low on many builds), so a single `IN (…)` binding one placeholder per live worker
 * would THROW once the fleet outgrows that limit — and the caller's read-failure fallback marks every
 * worker stale (a false fleet-wide drain/outage signal from mere scale). 900 stays safely under the
 * conservative 999 floor while keeping the batch count minimal; the live keys are chunked into batches of
 * this size and unioned, so the bounded hot-path read scales past the parameter cap. */
const IN_QUERY_MAX_PARAMS = 900;

/** A persisted enrolment row (`worker_harness_protocol`): one worker instance's advertised protocol. */
interface WorkerHarnessProtocolRow {
  instance: string;
  harness_protocol: number | null;
  updated_at: string;
}

/**
 * The configured minimum harness protocol a worker must advertise to be considered healthy. Read
 * through the ONE typed env schema ({@link NANO_AGENTIC_MIN_HARNESS_PROTOCOL}); a non-integer / blank
 * value degrades to the registered default rather than throwing (advisory — the report must never
 * fail on a malformed knob).
 */
export function minHarnessProtocol(env: Record<string, string | undefined> = process.env): number {
  const raw = readEnvOr("NANO_AGENTIC_MIN_HARNESS_PROTOCOL", String(DEFAULT_MIN_HARNESS_PROTOCOL), env).trim();
  // `Number.parseInt` accepts `"3junk"` (→ 3) and truncates `"1.9"` (→ 1), so a malformed/non-integer
  // knob would NOT degrade to the registered default as this function and the env contract promise.
  // Parse with `Number` and require a strict non-negative integer. A blank value (`Number("")` → 0)
  // must also fall through to the default, hence the explicit non-empty guard.
  const parsed = Number(raw);
  return raw.length > 0 && Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MIN_HARNESS_PROTOCOL;
}

/**
 * The configured staleness-enforcement policy. Read through the ONE typed env schema
 * ({@link NANO_AGENTIC_STALE_HARNESS_POLICY}); anything other than the exact `refuse` token (case- and
 * whitespace-insensitive) is the safe default `flag`, so a typo never silently drains the fleet.
 */
export function staleHarnessPolicy(env: Record<string, string | undefined> = process.env): StaleHarnessPolicy {
  const raw = readEnvOr("NANO_AGENTIC_STALE_HARNESS_POLICY", DEFAULT_STALE_HARNESS_POLICY, env).trim().toLowerCase();
  return raw === "refuse" ? "refuse" : "flag";
}

/**
 * Whether an advertised protocol is STALE against the minimum. A `undefined`/`null` protocol — a
 * harness that advertised NO version, or one never enrolled through this app — is stale (absent version
 * = stale, the #802 signature). Otherwise stale iff below the minimum.
 */
export function isStaleProtocol(
  protocol: number | undefined | null,
  min: number = minHarnessProtocol(),
): boolean {
  if (protocol === undefined || protocol === null || !Number.isFinite(protocol)) return true;
  return protocol < min;
}

/** A worker's harness-staleness assessment — the shape surfaced in `getAgenticSupply` / the registry. */
export interface HarnessAssessment {
  /** The worker instance id. */
  readonly instance: string;
  /** The advertised protocol version, when a numeric one is known (omitted for absent/none). */
  readonly harnessProtocol?: number;
  /** Whether the worker's harness is stale (below minimum, or no version advertised). */
  readonly stale: boolean;
}

/**
 * The result of {@link assessWorkersWithAvailability}: the per-instance assessments plus whether the
 * harness-protocol registry could actually be CONSULTED. `registryAvailable` is `false` when no data
 * layer is mounted or the read threw (a legacy DB predating migration 107, an in-flight desync); the
 * assessments still fail loud (every worker reads STALE) so per-worker supply visibility is unchanged,
 * but the registry report uses this flag to OMIT its `staleWorkers` list rather than mislabel an
 * outage as a fleet-wide drain signal (issue #802).
 */
export interface WorkerAssessment {
  /** False when the harness-protocol registry could not be consulted (no data layer, or the read threw). */
  readonly registryAvailable: boolean;
  /** The canonical per-instance staleness assessment (every requested instance is present). */
  readonly assessments: Map<string, HarnessAssessment>;
}

/**
 * The durable registry of per-worker advertised harness protocol, over the `worker_harness_protocol`
 * table (`db/migrations/107_worker_harness_protocol.sql`). Backed by the app's SQLite DataLayer through
 * the RAD `Table<T>` surface (`data.table(...)`) — NOT hand-written SQL — mirroring
 * {@link ../durableResume.ts DurableResumeRegistry}.
 */
export class HarnessProtocolRegistry {
  readonly #data: DataLayer;

  constructor(data: DataLayer) {
    this.#data = data;
  }

  #table() {
    return this.#data.table<WorkerHarnessProtocolRow>(HARNESS_PROTOCOL_TABLE, "instance");
  }

  /** Canonicalise an instance key: trim surrounding whitespace and reject a blank one — the instance
   * is the PRIMARY KEY, so a whitespace/blank key would create an unreachable row or let unrelated
   * workers collide. Returns the trimmed key, or `undefined` when empty/whitespace. */
  static #normaliseInstance(instance: string): string | undefined {
    const trimmed = instance.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  /** Coerce an advertised protocol to the stored INTEGER (or NULL when none/malformed). A finite
   * non-negative integer is stored; anything else records NULL — an "advertised no usable version"
   * marker that reads back as STALE. */
  static #coerce(protocol: number | undefined | null): number | null {
    if (typeof protocol === "number" && Number.isInteger(protocol) && protocol >= 0) return protocol;
    return null;
  }

  /**
   * Record a worker's advertised harness protocol at enrolment (an idempotent UPSERT keyed by
   * `instance`). A re-enrol overwrites the value so a harness that GAINS — or LOSES — protocol support
   * across a redeploy is reflected (a downgrade re-enrol without a version clears a stale-healthy value
   * to NULL → stale). The `findOne`-then-insert is racy under a concurrent duplicate enrol, so a
   * PRIMARY KEY fence collision folds into the update path (same end-state either way). A
   * blank/whitespace `instance` is a no-op — it cannot key a reachable row.
   */
  async recordEnrolment(instance: string, protocol: number | undefined | null): Promise<void> {
    const key = HarnessProtocolRegistry.#normaliseInstance(instance);
    if (key === undefined) return;
    const value = HarnessProtocolRegistry.#coerce(protocol);
    const table = this.#table();
    const now = new Date().toISOString();
    const existing = await table.findOne({ instance: key });
    if (existing) {
      await table.update(key, { harness_protocol: value, updated_at: now });
      return;
    }
    try {
      await table.insert({ instance: key, harness_protocol: value, updated_at: now });
    } catch (err) {
      if (!isFenceCollision(err)) throw err;
      await table.update(key, { harness_protocol: value, updated_at: now });
    }
  }

  /** The advertised protocol for a worker instance, or `undefined` when it advertised none (NULL row)
   * or was never enrolled here. */
  async protocolFor(instance: string): Promise<number | undefined> {
    const key = HarnessProtocolRegistry.#normaliseInstance(instance);
    if (key === undefined) return undefined;
    const row = await this.#table().findOne({ instance: key });
    const value = row?.harness_protocol;
    return typeof value === "number" ? value : undefined;
  }

  /** Every recorded (instance → advertised protocol) mapping, for a bulk supply/registry join. */
  async all(): Promise<Map<string, number | undefined>> {
    const rows = await this.#table().find({});
    const out = new Map<string, number | undefined>();
    for (const row of rows) {
      out.set(row.instance, typeof row.harness_protocol === "number" ? row.harness_protocol : undefined);
    }
    return out;
  }

  /**
   * The recorded protocols for a bounded set of live instances — the supply/registry hot-path read.
   * Unlike {@link all}, this scopes the query to the CURRENT `instances` set rather than scanning
   * every historical row, so a table that grows with disconnected worker instances does not turn each
   * 2-second cockpit poll into an O(history) full-table load (an instance is never removed on
   * disconnect). It issues ONE bounded `WHERE instance IN (…)` query over the normalised, de-duplicated
   * live keys — not a per-worker `findOne` — so the poll never degrades into an N+1 round-trip pattern
   * as the fleet grows (Copilot #802). The bound keys are chunked into batches under SQLite's
   * host-parameter cap ({@link IN_QUERY_MAX_PARAMS}) and unioned, so a very large fleet cannot overflow
   * a single `IN (…)`'s placeholder limit and throw (which the caller would mislabel as a fleet-wide
   * outage). A blank/whitespace instance is skipped (it can key no reachable
   * row); an empty set short-circuits without a query (`IN ()` is not valid SQL). Any read error
   * propagates so the caller can distinguish "registry unavailable" from "all healthy".
   */
  async protocolsFor(instances: readonly string[]): Promise<Map<string, number | undefined>> {
    const out = new Map<string, number | undefined>();
    // Normalise + de-duplicate the live keys to bind into a single bounded IN query.
    const keys = new Set<string>();
    for (const instance of instances) {
      const key = HarnessProtocolRegistry.#normaliseInstance(instance);
      if (key !== undefined) keys.add(key);
    }
    if (keys.size === 0) return out;
    const keyList = [...keys];
    // Chunk the bound keys into batches under SQLite's host-parameter cap (see IN_QUERY_MAX_PARAMS):
    // a single IN (…) binding one placeholder per live worker would throw once the fleet outgrows the
    // limit, and the caller then mislabels every worker stale (a false drain/outage signal from scale).
    const byKey = new Map<string, number | undefined>();
    for (let offset = 0; offset < keyList.length; offset += IN_QUERY_MAX_PARAMS) {
      const batch = keyList.slice(offset, offset + IN_QUERY_MAX_PARAMS);
      const placeholders = batch.map(() => "?").join(", ");
      const rows = await this.#data
        .open()
        .query<WorkerHarnessProtocolRow>(
          `SELECT instance, harness_protocol FROM ${HARNESS_PROTOCOL_TABLE} WHERE instance IN (${placeholders})`,
          batch,
        );
      for (const row of rows) {
        byKey.set(row.instance, typeof row.harness_protocol === "number" ? row.harness_protocol : undefined);
      }
    }
    // Key the result back by the caller's ORIGINAL instance strings (the assessment reads it by the
    // same key it passed in); an instance with no row reads back `undefined` → stale, unchanged.
    for (const instance of instances) {
      const key = HarnessProtocolRegistry.#normaliseInstance(instance);
      if (key === undefined) continue;
      out.set(instance, byKey.get(key));
    }
    return out;
  }
}

/** True when `err` is the durable PRIMARY KEY fence firing (a SQLite `UNIQUE constraint failed` from a
 * concurrent/duplicate enrol between our `findOne` and `insert`). `recordEnrolment` is an upsert, so a
 * collision means "the row now exists" — the same intended outcome as the update branch. Matched on
 * the message substring the RAD `Table` surface propagates verbatim (mirrors `DurableResumeRegistry`). */
function isFenceCollision(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

/**
 * Assess a set of worker instances against the recorded harness protocols and the configured minimum,
 * ALSO reporting whether the registry could be consulted — the ONE canonical staleness derivation
 * shared by `getAgenticSupply` and the registry report (no second heuristic). The read is bounded to
 * the current `instances` set (not an O(history) full-table scan). Best-effort: any registry read
 * failure (a legacy DB predating migration 107, an in-flight desync, no data layer mounted) degrades
 * to "unknown protocol" → every worker STALE (fail loud, per absent-version-is-stale) with
 * `registryAvailable: false`, rather than throwing — so a caller can OMIT an aggregate stale list
 * instead of mislabelling an outage as a drain signal.
 */
export async function assessWorkersWithAvailability(
  data: DataLayer | undefined,
  instances: readonly string[],
  env: Record<string, string | undefined> = process.env,
): Promise<WorkerAssessment> {
  const min = minHarnessProtocol(env);
  let protocols: Map<string, number | undefined> = new Map();
  let registryAvailable = false;
  if (data) {
    try {
      protocols = await new HarnessProtocolRegistry(data).protocolsFor(instances);
      registryAvailable = true;
    } catch (err) {
      console.warn(`[harness-protocol] supply assessment read failed: ${err}`);
    }
  }
  const out = new Map<string, HarnessAssessment>();
  for (const instance of instances) {
    const protocol = protocols.get(instance);
    const assessment: HarnessAssessment = { instance, stale: isStaleProtocol(protocol, min) };
    out.set(instance, protocol !== undefined ? { ...assessment, harnessProtocol: protocol } : assessment);
  }
  return { registryAvailable, assessments: out };
}

/**
 * The per-instance staleness assessments — the fail-loud supply path (a read failure reads every
 * worker as STALE). A thin projection of {@link assessWorkersWithAvailability} for callers that only
 * need the per-worker verdict and not the registry-availability signal (there is ONE derivation).
 */
export async function assessWorkers(
  data: DataLayer | undefined,
  instances: readonly string[],
  env: Record<string, string | undefined> = process.env,
): Promise<Map<string, HarnessAssessment>> {
  return (await assessWorkersWithAvailability(data, instances, env)).assessments;
}
