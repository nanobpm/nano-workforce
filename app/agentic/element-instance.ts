// nano-workforce — resolve an agent job's ENGINE ELEMENT-INSTANCE KEY from its jobKey (#544).
//
// The durable correlation store (`./correlation-store.ts`) has historically keyed an agent session's
// engine context on the STATIC BPMN `element_id`. That id is ambiguous across a looping / retried
// activity: every re-activation of the same task id is a DISTINCT element instance sharing one id, so
// a transcript keyed on `element_id` alone cannot say WHICH occupancy produced it. #544 keys on the
// engine's per-occupancy handle instead — the `elementInstanceKey` — which is exactly what Nano
// Explorer addresses runtime position by and what Camunda keys its agent model on.
//
// The engine does not offer a `getJob(jobKey)` lookup, but it DOES surface every parked element
// instance via the element-instance wait-state read (`POST /v2/element-instances/wait-states/search`,
// bound onto the `@nanobpm/urban` EngineClient by nano-ide#473). A service task awaiting a worker is a
// `JOB` park, and that park carries BOTH its `jobKey` AND its owning `elementInstanceKey`. So the join
// is: list the live JOB parks, find the one whose `jobKey` matches the agent job, and read off its
// `elementInstanceKey`. Because a park is keyed to a specific element instance, this is unambiguous
// even when many iterations of the same static element are (or have been) live — each iteration is a
// separate park with a separate jobKey (see the looping/retried-job test).
//
// Invariant fit (ADR 0056): this is an ADVISORY, READ-ONLY engine query — it observes the engine's
// read model to enrich a visibility record. It NEVER activates/completes a job, publishes a message,
// or gates a BPMN sequence flow; the Camunda-8 job protocol (worker⇄engine) is untouched. It is
// deliberately expressed against a narrow reader shape (not the whole EngineClient) so the callers
// that drive it stay structurally decoupled from the engine.
import type { ElementInstanceWaitState, ElementInstanceWaitStateFilter, ProcessInstanceSnapshot } from "@nanobpm/urban";

/**
 * The narrow slice of the engine read model this resolver needs: the element-instance wait-state
 * search. `@nanobpm/urban`'s `EngineClient` satisfies it structurally; a test supplies a fake.
 */
export interface ElementInstanceWaitStateReader {
  searchElementInstanceWaitStates(
    filter?: ElementInstanceWaitStateFilter,
  ): Promise<readonly ElementInstanceWaitState[]>;
  /**
   * The process-instance read (#948), used to resolve a job's ROOT process instance when it runs in a
   * callActivity child. Optional: without it a placement simply carries no root.
   */
  searchProcessInstances?(filter?: { processInstanceKeys?: string[] }): Promise<readonly ProcessInstanceSnapshot[]>;
}

/**
 * Where a live agent job sits in the engine (#544, #948): the element instance its token occupies, the
 * process instance that owns it, its static element id, and — when the job runs in a callActivity child
 * — the root of that call hierarchy. The relay links a job off the wire knowing only its jobKey, so this
 * placement is what lets the cockpit's process focus follow a RUNNING job (the "Transcript" grid link
 * names the root run, while the agent often runs in a child cell such as `implement-cell`).
 */
export interface JobPlacement {
  readonly elementInstanceKey: string;
  readonly processInstanceKey: string;
  readonly elementId: string;
  readonly rootProcessInstanceKey?: string;
}

/** Optional scoping for {@link resolveElementInstanceKey} (a performance narrowing, never required). */
export interface ResolveElementInstanceOptions {
  /**
   * The owning process instance, when the caller already knows it. Passed to the engine as a search
   * filter so the read is scoped to one process instance rather than every live JOB park. It is a pure
   * OPTIMISATION: the `jobKey` is the match key and is engine-unique, so an unscoped search resolves
   * the same element instance — just over a larger candidate set.
   */
  readonly processInstanceKey?: string;
}

/**
 * Resolve the `elementInstanceKey` the agent job identified by `jobKey` occupies, by matching the
 * job against the engine's live `JOB` wait-state parks. Returns `undefined` when the job is not (or no
 * longer) parked — e.g. it already completed and released its park, or the jobKey is empty — which the
 * advisory callers treat as "not resolved", never an error.
 *
 * The resolution keys on `jobKey`, NOT `elementId`: that is the whole point of #544. A retried /
 * looping activity has many parks sharing one `elementId` but each with its own `jobKey` and its own
 * `elementInstanceKey`, so matching on `jobKey` returns the correct per-occupancy instance.
 */
export async function resolveElementInstanceKey(
  reader: ElementInstanceWaitStateReader,
  jobKey: string,
  options: ResolveElementInstanceOptions = {},
): Promise<string | undefined> {
  return (await findJobPark(reader, jobKey, options))?.elementInstanceKey;
}

/** The live JOB park whose `jobKey` matches, or undefined — the one match both resolvers share. */
async function findJobPark(
  reader: ElementInstanceWaitStateReader,
  jobKey: string,
  options: ResolveElementInstanceOptions,
): Promise<ElementInstanceWaitState | undefined> {
  if (jobKey === "") return undefined;
  const filter: ElementInstanceWaitStateFilter = { waitStateType: "JOB" };
  if (options.processInstanceKey !== undefined && options.processInstanceKey !== "") {
    filter.processInstanceKey = options.processInstanceKey;
  }
  const parks = await reader.searchElementInstanceWaitStates(filter);
  return parks.find((park) => park.waitStateType === "JOB" && park.jobKey === jobKey);
}

/**
 * Resolve the full {@link JobPlacement} of the live agent job `jobKey` (#948): the matching JOB park's
 * element instance, process instance and element id, plus — best-effort, when the reader exposes the
 * process-instance read — the root process instance of its call hierarchy. Undefined when the job is
 * not (or no longer) parked. A failed root lookup is advisory: the placement resolves without a root.
 */
export async function resolveJobPlacement(
  reader: ElementInstanceWaitStateReader,
  jobKey: string,
  options: ResolveElementInstanceOptions & { readonly rootCache?: Map<string, string> } = {},
): Promise<JobPlacement | undefined> {
  const park = await findJobPark(reader, jobKey, options);
  if (park === undefined) return undefined;
  const placement: JobPlacement = {
    elementInstanceKey: park.elementInstanceKey,
    processInstanceKey: park.processInstanceKey,
    elementId: park.elementId,
  };
  const key = park.processInstanceKey;
  if (reader.searchProcessInstances === undefined || key === "") return placement;
  // An instance's root never changes, so a cached root spares the engine a read on every periodic
  // reconcile pass (#691 reuses this resolver for its job-state check).
  const cached = options.rootCache?.get(key);
  if (cached !== undefined) return { ...placement, rootProcessInstanceKey: cached };
  try {
    const [instance] = await reader.searchProcessInstances({ processInstanceKeys: [key] });
    const root = instance?.rootProcessInstanceKey;
    if (root === undefined || root === "") return placement;
    if (options.rootCache !== undefined) {
      if (options.rootCache.size >= ROOT_CACHE_MAX) options.rootCache.clear();
      options.rootCache.set(key, root);
    }
    return { ...placement, rootProcessInstanceKey: root };
  } catch {
    return placement;
  }
}

/** Bound on the per-resolver root cache; cleared wholesale when full (entries are cheap to re-read). */
const ROOT_CACHE_MAX = 1000;

/**
 * The narrow, advisory job-placement resolution seam the relay slice fires at link time (#544, #948):
 * given an agent `jobKey` (and its owning `processInstanceKey` when known), resolve its
 * {@link JobPlacement}, or `undefined` when it is not resolvable. A function shape — NOT
 * an `EngineClient` — so the agentic families depend on a capability, not the engine itself; the
 * composition root ({@link file://main.ts}) closes it over the real engine, a test over a fake.
 */
export type ElementInstanceResolver = (
  jobKey: string,
  processInstanceKey?: string,
) => Promise<JobPlacement | undefined>;

/**
 * Build an {@link ElementInstanceResolver} bound to an engine wait-state reader — the closure the
 * composition root threads into the agentic channel so the relay slice can resolve an agent job's
 * element instance without holding an engine reference of its own.
 */
export function makeElementInstanceResolver(reader: ElementInstanceWaitStateReader): ElementInstanceResolver {
  const rootCache = new Map<string, string>();
  return (jobKey, processInstanceKey) => resolveJobPlacement(reader, jobKey, { processInstanceKey, rootCache });
}
