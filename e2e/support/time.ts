import type { TestApp } from "@nanobpm/urban-testkit";

/**
 * Advance a long BPMN **business-wait** boundary timer and reconcile once.
 *
 * A business wait — "park at this task until the 24h SLA elapses, then auto-escalate" — is
 * modelled as a BPMN interrupting boundary timer on the ENGINE clock: durable, engine-owned, and
 * already virtual under the engine clock. This is the line camunda/orchestration-cluster-api-js#450
 * draws: *"Long/business waits are BPMN timer events … not [runtime-cadence] `sleep`/poll."* To
 * cross such a wait we advance the ENGINE clock so the boundary fires, then {@link TestApp.settle}
 * once to drain the follow-on token flow.
 *
 * This deliberately does **not** call {@link TestApp.advanceTime}, which steps the virtual-clock
 * scheduler in lockstep with the engine and therefore REPLAYS every short runtime-cadence poll —
 * the 5s `instanceTracking` reconcilers — once per interval across the whole window. A 25h jump
 * replays each poller ~18,000× (measured: ~123s of pure no-op reconcile churn *per call*, which is
 * essentially the entire e2e wall-clock). Those replays are runtime cadence, not the business wait,
 * and #450 treats such busy-replays as a bug to *surface*, not to coalesce away in the scheduler.
 * Advancing engine time + one settle fires the same boundary in ~2ms.
 *
 * Use ONLY when the assertions target **engine state** — taken sequence-flows (`app.snapshot()`) or
 * instance state — which is populated by `engine.advanceTime` + `engine.drain` (run inside
 * `settle`). Do NOT use it when an assertion depends on a **read model the reconcile pollers
 * project**: for that the pollers must actually run, so use {@link TestApp.advanceTime}. The
 * scheduler's virtual clock intentionally does not track this jump.
 */
export async function advancePastTimer(
  app: Pick<TestApp, "engine" | "settle">,
  ms: number,
): Promise<void> {
  await app.engine.advanceTime(ms);
  await app.settle();
}
