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

/**
 * Settle the deterministic harness to true quiescence — repeat {@link TestApp.settle} until no job
 * remains mid-flight (`ACTIVATED`) — for any scenario where a worker ENROLLS a PR.
 *
 * The canonical convergence enrollment `submitPr` (used by `pr.record-wave`, `pr.converge-feature`
 * and `pr.delivery-connector`) calls `engine.createInstance` from INSIDE a worker job handler. The
 * urban-testkit services that nested creation with a nested `drain()`; now that `convergence-loop`
 * opens with the host `pr.capture-head` task (issue #786), that nested drain runs real re-entrant
 * host work and — per the testkit's documented re-entrancy — leaves the ENROLLING worker's own
 * completion "undrained until a later settle". A single `settle()` therefore observes the enroller
 * one tick early (e.g. a `feature_runs` row still `opened`, or a plan not yet parked on its
 * trial-merge task). At real runtime the async job stream drains this with no extra prompting; the
 * harness just needs to be driven to quiescence.
 *
 * The reliable quiescence signal is a job in state `ACTIVATED`: that is a leased, mid-flight job —
 * the undrained enrolling-worker completion the re-entrancy leaves behind. A `settle()` drains every
 * *registered*-worker job to completion, so once no `ACTIVATED` job remains the only jobs left are
 * genuine external parks (`CREATED` agent jobs with no registered worker), and the harness is
 * quiescent. Keying on `ACTIVATED` is precise, not a retry-and-hope: it is NOT sufficient to compare
 * successive `snapshot()` signatures, because the undrained completion is invisible between certain
 * settles (two passes look identical while work is still pending), so a naive fixpoint returns early
 * and the re-entrant work later fires against a closing DB.
 */
export async function settleFully(
  app: Pick<TestApp, "settle" | "engine">,
  maxRounds = 16,
): Promise<void> {
  for (let round = 0; round < maxRounds; round++) {
    await app.settle();
    const jobs = await app.engine.searchJobs({});
    if (!jobs.some((job) => job.state === "ACTIVATED")) return;
  }
}
