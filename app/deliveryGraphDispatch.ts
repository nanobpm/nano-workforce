// app/deliveryGraphDispatch.ts — the delivery-graph DISPATCH core (ADR 0005 Decision 7, issue #460).
// This is the retained run-launch logic (compile → content-address → idempotent at-most-once claim →
// deploy+start the S4 runner → stamp the instance) extracted out of the removed agent `start` door so
// it is invoked ONLY from the cockpit dispatch action — never an agent-callable operation.
//
// The old `start` door gated dispatch on a REPLAYABLE `approvalToken` (the content digest handed back
// to the same caller), which let any holder of the API credential self-approve. Under issue #460 the
// human clicking Dispatch in the cockpit IS the approval — so there is NO approval gate here; the
// authorization lives in the fact that only the cockpit dispatch seam reaches this code, not the agent
// surface. What IS retained is the durable at-most-once launch fence (`claimRunForLaunch`) and the
// idempotency short-circuit, so a double-click or a re-dispatch never double-launches a graph's side
// effects.

import type { AppApi } from "@nanobpm/urban";
import type { DeliveryGraph } from "../nano-generated/api-io.d.ts";
import { validateDeliveryGraph } from "./deliveryGraph.ts";
import { compileDeliveryGraph } from "./deliveryGraphCompiler.ts";
import {
  buildDeliveryGraphRunRow,
  buildHumanLabels,
  claimRunForLaunch,
  computeRunKey,
  DELIVERY_PHASE,
  deliveryGraphRuns,
} from "./deliveryGraphRun.ts";
import type { DeliveryRunTimeouts } from "./deliveryRunner.ts";
import { deliveryGraphDigest, runDeliveryGraph } from "./deliveryRunner.ts";

/** The outcome of a dispatch attempt — mirrors the retained run lifecycle. `ok:false` carries the
 * path-qualified compile/validation errors (a staged graph should always recompile, but a corrupt
 * stored graph is refused cleanly rather than throwing). */
export type DispatchDeliveryGraphResult =
  | {
      ok: true;
      status: "running";
      runKey: string;
      digest: string;
      sideEffecting: boolean;
      alreadyRunning: boolean;
      processInstanceKey?: string;
      processDefinitionId?: string;
    }
  | { ok: false; errors: { path: string; message: string }[] };

/** Dispatch a delivery graph as a running engine-native process — the operator action. Re-validates
 * and re-compiles the (already-staged) graph to derive its content digest + run-row shape, then
 * launches it through the durable at-most-once fence. Idempotent: a re-dispatch of an already-running
 * run short-circuits with `alreadyRunning` instead of double-launching. */
export async function dispatchDeliveryGraphRun(
  app: Pick<AppApi, "data" | "engine" | "log">,
  graph: unknown,
  options: { runKey?: string | null; title?: string | null; repository?: string | null; baseBranch?: string | null } & DeliveryRunTimeouts = {},
): Promise<DispatchDeliveryGraphResult> {
  const validationErrors = validateDeliveryGraph(graph);
  if (validationErrors.length > 0) {
    return { ok: false, errors: validationErrors };
  }
  // The graph passed the semantic validator above, so it is safe to narrow to the typed contract.
  // biome-ignore lint/plugin: validated external body narrowed to its contract after validateDeliveryGraph
  const typedGraph = graph as DeliveryGraph;
  const compiled = await compileDeliveryGraph(typedGraph);
  if (!compiled.ok) {
    return { ok: false, errors: compiled.errors };
  }

  const digest = deliveryGraphDigest(compiled.bpmn);
  const runKey = computeRunKey(options.runKey, digest);
  const sideEffecting = compiled.sideEffects.length > 0;
  const explicitTitle = typeof options.title === "string" && options.title.trim() !== "" ? options.title.trim() : "";
  const graphName = typeof typedGraph.name === "string" && typedGraph.name.trim() !== "" ? typedGraph.name.trim() : "";
  const title = explicitTitle || graphName || runKey;
  const runs = deliveryGraphRuns(app.data);

  // Idempotency short-circuit — a re-dispatch onto a still-running run does NOT double-launch.
  const existing = await runs.get(runKey);
  if (existing && existing.status === "running") {
    app.log.info("dispatch-delivery-graph short-circuit: already running", { runKey });
    return {
      ok: true,
      status: "running",
      runKey,
      digest: existing.digest,
      sideEffecting: existing.side_effecting === 1,
      alreadyRunning: true,
      processInstanceKey: existing.process_key ?? undefined,
      processDefinitionId: existing.process_definition_id ?? undefined,
    };
  }

  const rowBase = {
    runKey,
    digest,
    sideEffecting,
    nodeCount: compiled.resolved.nodes.length,
    humanNodeCount: compiled.humanNodes.length,
    sideEffectCount: compiled.sideEffects.length,
    title,
    humanLabels: buildHumanLabels(compiled),
    createdAt: existing?.created_at,
  };

  // Claim the run durably BEFORE the side effect (the at-most-once dispatch fence). A losing racer
  // never reaches `runDeliveryGraph` — it re-reads the winner's row and short-circuits.
  const claim = buildDeliveryGraphRunRow({ ...rowBase, status: "running", phase: DELIVERY_PHASE.RUNNING, processKey: null });
  const wonClaim = await claimRunForLaunch(app.data, Boolean(existing), claim);
  if (!wonClaim) {
    const won = await runs.get(runKey);
    app.log.info("dispatch-delivery-graph short-circuit: launch claim raced a concurrent dispatch", { runKey });
    return {
      ok: true,
      status: "running",
      runKey,
      digest: won?.digest ?? digest,
      sideEffecting: won ? won.side_effecting === 1 : sideEffecting,
      alreadyRunning: true,
      processInstanceKey: won?.process_key ?? undefined,
      processDefinitionId: won?.process_definition_id ?? undefined,
    };
  }
  if (existing) {
    const { run_key, created_at, ...patch } = claim;
    await runs.update(runKey, patch);
  }

  // Launch — deploy + start the compiled definition. On ANY launch failure flip the claimed row to
  // `failed` so no null-process_key `running` row is ever stranded.
  const markClaimFailed = async () => {
    const failed = buildDeliveryGraphRunRow({ ...rowBase, status: "failed", phase: DELIVERY_PHASE.FAILED, processKey: null });
    const { run_key, created_at, ...patch } = failed;
    await runs.update(runKey, patch);
  };
  let launched: Awaited<ReturnType<typeof runDeliveryGraph>>;
  try {
    // Thread the operator-supplied run-level timeouts (#505) so a submission override reaches every
    // node's seeded `nodeInputs` (absent → the runner's PT1H/PT30M/P1D defaults).
    launched = await runDeliveryGraph(app.engine, typedGraph, {
      runKey,
      nodeTimeout: options.nodeTimeout,
      probeTimeout: options.probeTimeout,
      escalationSlaTimeout: options.escalationSlaTimeout,
      probePollEvery: options.probePollEvery,
      escalationAssignee: options.escalationAssignee,
      // Host-git provisioning (#684/#686): forward the run-level repo/base so the runner seeds the
      // `io.nanobpm.agentTask.repository` isolation envelope onto every agent cell's job (absent → the
      // runner emits no envelope and the harness keeps its legacy launch-dir behaviour).
      repository: options.repository,
      baseBranch: options.baseBranch,
    });
  } catch (err) {
    await markClaimFailed();
    app.log.error("dispatch-delivery-graph launch threw", { runKey });
    throw err;
  }
  if (!launched.ok) {
    await markClaimFailed();
    app.log.error("dispatch-delivery-graph launch failed", { runKey, count: launched.errors.length });
    return { ok: false, errors: launched.errors };
  }

  // Stamp the started instance key onto the claimed row.
  {
    const running = buildDeliveryGraphRunRow({
      ...rowBase,
      status: "running",
      phase: DELIVERY_PHASE.RUNNING,
      processKey: launched.handle.processInstanceKey,
      processDefinitionId: launched.handle.processDefinitionId,
    });
    const { run_key, created_at, ...patch } = running;
    await runs.update(runKey, patch);
  }
  app.log.info("delivery graph dispatched", { runKey, processInstanceKey: launched.handle.processInstanceKey });
  return {
    ok: true,
    status: "running",
    runKey,
    digest,
    sideEffecting,
    alreadyRunning: false,
    processInstanceKey: launched.handle.processInstanceKey,
    processDefinitionId: launched.handle.processDefinitionId,
  };
}
