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
import type { ElementInstanceWaitState, ElementInstanceWaitStateFilter } from "@nanobpm/urban";

/**
 * The narrow slice of the engine read model this resolver needs: the element-instance wait-state
 * search. `@nanobpm/urban`'s `EngineClient` satisfies it structurally; a test supplies a fake.
 */
export interface ElementInstanceWaitStateReader {
  searchElementInstanceWaitStates(
    filter?: ElementInstanceWaitStateFilter,
  ): Promise<readonly ElementInstanceWaitState[]>;
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
  if (jobKey === "") return undefined;
  const filter: ElementInstanceWaitStateFilter = { waitStateType: "JOB" };
  if (options.processInstanceKey !== undefined && options.processInstanceKey !== "") {
    filter.processInstanceKey = options.processInstanceKey;
  }
  const parks = await reader.searchElementInstanceWaitStates(filter);
  for (const park of parks) {
    // Narrow to the JOB variant (the discriminant guards `jobKey`); a non-JOB park never carries the
    // jobKey field even if the engine ignored the filter. Match on the engine-unique jobKey.
    if (park.waitStateType === "JOB" && park.jobKey === jobKey) {
      return park.elementInstanceKey;
    }
  }
  return undefined;
}

/**
 * The narrow, advisory element-instance resolution seam the relay slice fires at link time (#544):
 * given an agent `jobKey` (and its owning `processInstanceKey` when known), resolve the engine
 * element-instance key it occupies, or `undefined` when it is not resolvable. A function shape — NOT
 * an `EngineClient` — so the agentic families depend on a capability, not the engine itself; the
 * composition root ({@link file://main.ts}) closes it over the real engine, a test over a fake.
 */
export type ElementInstanceResolver = (
  jobKey: string,
  processInstanceKey?: string,
) => Promise<string | undefined>;

/**
 * Build an {@link ElementInstanceResolver} bound to an engine wait-state reader — the closure the
 * composition root threads into the agentic channel so the relay slice can resolve an agent job's
 * element instance without holding an engine reference of its own.
 */
export function makeElementInstanceResolver(reader: ElementInstanceWaitStateReader): ElementInstanceResolver {
  return (jobKey, processInstanceKey) => resolveElementInstanceKey(reader, jobKey, { processInstanceKey });
}
