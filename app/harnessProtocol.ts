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
  const raw = readEnvOr("NANO_AGENTIC_MIN_HARNESS_PROTOCOL", String(DEFAULT_MIN_HARNESS_PROTOCOL), env);
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MIN_HARNESS_PROTOCOL;
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
    return this.#data.table<WorkerHarnessProtocolRow>("worker_harness_protocol", "instance");
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
}

/** True when `err` is the durable PRIMARY KEY fence firing (a SQLite `UNIQUE constraint failed` from a
 * concurrent/duplicate enrol between our `findOne` and `insert`). `recordEnrolment` is an upsert, so a
 * collision means "the row now exists" — the same intended outcome as the update branch. Matched on
 * the message substring the RAD `Table` surface propagates verbatim (mirrors `DurableResumeRegistry`). */
function isFenceCollision(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

/**
 * Assess a set of worker instances against the recorded harness protocols and the configured minimum —
 * the ONE canonical staleness derivation shared by `getAgenticSupply` and the registry report (no
 * second heuristic). Best-effort: any registry read failure (a legacy DB predating migration 107, an
 * in-flight desync, no data layer mounted) degrades to "unknown protocol" → every worker STALE (fail
 * loud, per absent-version-is-stale), rather than throwing.
 */
export async function assessWorkers(
  data: DataLayer | undefined,
  instances: readonly string[],
  env: Record<string, string | undefined> = process.env,
): Promise<Map<string, HarnessAssessment>> {
  const min = minHarnessProtocol(env);
  let protocols: Map<string, number | undefined> = new Map();
  if (data) {
    try {
      protocols = await new HarnessProtocolRegistry(data).all();
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
  return out;
}
