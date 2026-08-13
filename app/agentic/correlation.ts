// nano-workforce — the jobKey ⇄ process-instance / plan correlation registry (ADR 0056, H6 / #149).
//
// The closing slice of the agentic-visibility epic (#142). It answers ADR 0056's open question —
// "which process instance / plan is THIS terminal?" — by carrying the one fact neither presence (H1)
// nor the relay (H3) holds: the association between a worker instance, the jobKeys it is currently
// processing, and each jobKey's engine context (process instance, BPMN process, plan/epic).
//
// Why a separate registry (derivation over duplication): presence rows carry the worker's declared
// enrolment capability but NO job attribution, and relay streams carry bytes but NO engine context.
// The correlation is the single canonical join between them:
//   - `jobKeysFor(instance)` is the resolver H1's `PresenceRegistry.snapshot({ jobKeysFor })` seam
//     asks for, so a worker's current jobKeys light up in the supply feed / cockpit.
//   - `resolve(jobKey)` gives the cockpit the process-instance / plan a terminal belongs to, so the
//     drilled bytes line up with "that process instance / this plan".
//   - the relay terminal for a job is the jobKey-scoped stream {@link jobStream} — a stable naming
//     convention (`job:<jobKey>`) so the report can repoint a worker's drill stream at its live job
//     without a second lookup table.
//
// Who populates it: the orchestrator that dispatches an agentic job to a worker (it holds the whole
// job payload — jobKey, processInstanceKey, bpmnProcessId, and the plan/epic it belongs to) calls
// {@link CorrelationRegistry.link} when the worker picks the job up and {@link CorrelationRegistry.releaseJob}
// (or {@link CorrelationRegistry.releaseInstance} on disconnect) when it finishes. This is the seam
// the end-to-end wiring test drives directly.
//
// Invariants (ADR 0056): app-tier only, never the engine; the Camunda-8 job protocol (worker⇄engine)
// is untouched — correlation is an app-side observation, not a new wire type; ADVISORY — it is a
// read-only join for visibility and NEVER hard-locks or gates a BPMN sequence flow.

/** The relay-stream prefix for a jobKey-scoped terminal stream. */
export const JOB_STREAM_PREFIX = "job:";

/** The stable relay stream id a worker relays a job's terminal on: `job:<jobKey>`. */
export function jobStream(jobKey: string): string {
  return `${JOB_STREAM_PREFIX}${jobKey}`;
}

/**
 * The jobKey encoded in a jobKey-scoped relay stream id, or undefined for any other stream.
 * A bare `job:` prefix with no suffix carries no jobKey, so it maps to undefined too — keeping
 * the "empty jobKey is invalid" invariant (`link()` ignores empty jobKeys) consistent for callers.
 */
export function jobKeyOfStream(stream: string): string | undefined {
  if (!stream.startsWith(JOB_STREAM_PREFIX)) return undefined;
  const jobKey = stream.slice(JOB_STREAM_PREFIX.length);
  return jobKey === "" ? undefined : jobKey;
}

/** One job's engine context — the correlation a terminal is lined up against. */
export interface JobCorrelation {
  /** The Camunda-8 job key (the C8 job the worker activated). */
  readonly jobKey: string;
  /** The owning process instance key, if known. */
  readonly processInstanceKey?: string;
  /** The BPMN process id the job belongs to, if known. */
  readonly bpmnProcessId?: string;
  /** The BPMN element id (activity/task) the job is for, if known. */
  readonly elementId?: string;
  /** The plan / epic key this job is part of (e.g. `owner/repo#142`), if known. */
  readonly planKey?: string;
  /** The relay stream id the job's terminal is relayed on (`job:<jobKey>`). */
  readonly stream: string;
}

/** The context an orchestrator supplies when a worker picks up a job (jobKey excluded — it is the key). */
export type JobContext = Omit<JobCorrelation, "jobKey" | "stream">;

/** The read-only correlation snapshot: every currently-linked job, sorted by jobKey. */
export interface CorrelationSnapshot {
  readonly correlations: readonly JobCorrelation[];
  readonly count: number;
}

/**
 * The advisory in-memory correlation registry. It holds two derived-from-one-write projections of the
 * same `link` call: `instance → jobKeys` (the presence resolver) and `jobKey → context` (the cockpit
 * lookup). A jobKey belongs to at most one instance at a time; re-linking it moves it (and drops the
 * stale reverse edge) so a re-dispatched job never double-counts.
 */
export class CorrelationRegistry {
  /** jobKey → the worker instance currently processing it. */
  readonly #instanceOf = new Map<string, string>();
  /** worker instance → the set of jobKeys it is currently processing (insertion-ordered). */
  readonly #jobsOf = new Map<string, Set<string>>();
  /** jobKey → its engine context. */
  readonly #context = new Map<string, JobCorrelation>();

  /**
   * Link a worker instance to a job it is now processing, recording the job's engine context. A
   * re-link of the same jobKey to a different instance moves it (dropping the old reverse edge); a
   * re-link with fresh context overwrites the context (last write wins). Both args must be non-empty.
   */
  link(instance: string, jobKey: string, context: JobContext = {}): void {
    if (instance === "" || jobKey === "") return;
    const previousInstance = this.#instanceOf.get(jobKey);
    if (previousInstance !== undefined && previousInstance !== instance) {
      this.#jobsOf.get(previousInstance)?.delete(jobKey);
      this.#pruneInstance(previousInstance);
    }
    this.#instanceOf.set(jobKey, instance);
    const jobs = this.#jobsOf.get(instance) ?? new Set<string>();
    jobs.add(jobKey);
    this.#jobsOf.set(instance, jobs);
    this.#context.set(jobKey, { jobKey, stream: jobStream(jobKey), ...stripUndefined(context) });
  }

  /** Release one job (it finished / moved on). No-op if it was never linked. */
  releaseJob(jobKey: string): void {
    const instance = this.#instanceOf.get(jobKey);
    if (instance !== undefined) {
      this.#jobsOf.get(instance)?.delete(jobKey);
      this.#pruneInstance(instance);
    }
    this.#instanceOf.delete(jobKey);
    this.#context.delete(jobKey);
  }

  /** Release every job a worker instance held (e.g. on disconnect / presence timeout). */
  releaseInstance(instance: string): void {
    const jobs = this.#jobsOf.get(instance);
    if (!jobs) return;
    for (const jobKey of jobs) {
      this.#instanceOf.delete(jobKey);
      this.#context.delete(jobKey);
    }
    this.#jobsOf.delete(instance);
  }

  /**
   * The jobKeys a worker instance is currently processing, sorted for a stable render. This is the
   * resolver injected into {@link PresenceRegistry.snapshot}'s `jobKeysFor` seam.
   */
  jobKeysFor(instance: string): string[] {
    const jobs = this.#jobsOf.get(instance);
    return jobs ? [...jobs].sort((a, b) => a.localeCompare(b)) : [];
  }

  /** The engine context for a jobKey, or undefined when it is not (or no longer) linked. */
  resolve(jobKey: string): JobCorrelation | undefined {
    return this.#context.get(jobKey);
  }

  /**
   * The jobKey-scoped relay stream a worker's terminal should drill into: its lowest-sorted current
   * jobKey's stream (a worker processes one job at a time in this fleet, but sorting keeps it stable
   * if it ever holds several). Undefined when the worker has no linked job — the caller then falls
   * back to the instance-keyed stream.
   */
  primaryStreamFor(instance: string): string | undefined {
    const [first] = this.jobKeysFor(instance);
    return first === undefined ? undefined : jobStream(first);
  }

  /** The number of currently-linked jobs. */
  count(): number {
    return this.#context.size;
  }

  /** The read-only correlation snapshot: every linked job, sorted by jobKey. */
  snapshot(): CorrelationSnapshot {
    const correlations = [...this.#context.values()].sort((a, b) => a.jobKey.localeCompare(b.jobKey));
    return { correlations, count: correlations.length };
  }

  /** Drop a worker's reverse-edge entry once it holds no more jobs, so the map stays bounded. */
  #pruneInstance(instance: string): void {
    const jobs = this.#jobsOf.get(instance);
    if (jobs && jobs.size === 0) this.#jobsOf.delete(instance);
  }
}

/** Drop `undefined`-valued keys so an optional context field never overwrites a known value with a hole. */
function stripUndefined(context: JobContext): JobContext {
  const { processInstanceKey, bpmnProcessId, elementId, planKey } = context;
  return {
    ...(processInstanceKey !== undefined ? { processInstanceKey } : {}),
    ...(bpmnProcessId !== undefined ? { bpmnProcessId } : {}),
    ...(elementId !== undefined ? { elementId } : {}),
    ...(planKey !== undefined ? { planKey } : {}),
  };
}

/** The live correlation registry from the most recent mount, so the supply report (H5) can read it. */
let currentRegistry: CorrelationRegistry | undefined;

/** The mounted correlation registry, or undefined before mount / after teardown. */
export function currentCorrelation(): CorrelationRegistry | undefined {
  return currentRegistry;
}

/** Install the live registry (called by the correlation family's `mount`). */
export function setCurrentCorrelation(registry: CorrelationRegistry | undefined): void {
  currentRegistry = registry;
}
