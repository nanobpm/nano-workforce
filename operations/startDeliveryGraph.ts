// POST /app/api/actions/start/delivery-graph → operationId `startDeliveryGraph` (ADR 0005 slice S5,
// Decision 7). The ONE gated dispatch door for a delivery graph: it turns an agent-authored
// `DeliveryGraph` into a RUNNING engine-native process. Three ingress paths — an agent-ergonomic POST,
// a raw REST call, and a UI JSON-paste — all hit this ONE contract.
//
// This is the OUTER action, deliberately distinct from S1's pure `compileDeliveryGraph`: compile and
// start are SEPARATE operations (Decision 5/7), so there is NO `dryRun` flag here. The door composes
// the already-merged slices — it re-validates via S0 (`validateDeliveryGraph`), compiles via S1
// (`compileDeliveryGraph`), and launches via S4 (`runDeliveryGraph`) — and adds the two properties a
// DISPATCH (unlike a pure compile) must have:
//
//   • APPROVAL (Decision 7). Because these graphs merge PRs and publish packages, a graph with any
//     side-effecting node (`agent`/`connector`) dispatches ONLY when the caller presents the graph's
//     content-addressed `approvalToken` (== the compiled `digest`) — an approval OF the rendered
//     preview. A side-effecting graph submitted without it is REFUSED (400) and PARKED as an
//     `awaiting-approval` run (visible in the cockpit), the response carrying the token to re-submit
//     with. A graph with no side effects (only `wait`/`human`) needs no approval and dispatches.
//   • IDEMPOTENCY. A run is keyed by `runKey` (a caller `idempotencyKey`, else the content `digest`);
//     a re-POST of the same graph short-circuits an already-running run instead of double-launching —
//     mirroring `startPlan`'s `alreadyRunning`.

import { isUniqueConstraintFence } from "../app/dbFence.ts";
import { validateDeliveryGraph } from "../app/deliveryGraph.ts";
import { compileDeliveryGraph } from "../app/deliveryGraphCompiler.ts";
import {
  buildDeliveryGraphRunRow,
  buildHumanLabels,
  claimRunForLaunch,
  computeRunKey,
  DELIVERY_PHASE,
  deliveryGraphRuns,
  isDeliveryGraphApproved,
} from "../app/deliveryGraphRun.ts";
import { deliveryGraphDigest, runDeliveryGraph } from "../app/deliveryRunner.ts";
import { defineOperation } from "../nano-generated/operations.ts";

export default defineOperation("startDeliveryGraph", async ({ body }, app) => {
  // The runtime validates a well-formed body against openapi.yaml, but a directly-invoked delegate (or
  // a missing body) leaves `body` undefined — guard so that becomes a 400, not a 500.
  if (!body || typeof body !== "object" || !("graph" in body) || body.graph === null || typeof body.graph !== "object") {
    app.log.warn("start-delivery-graph rejected: missing graph");
    return { status: 400, body: { ok: false, errors: [{ path: "graph", message: "request body must carry a `graph`" }] } };
  }
  const graph = body.graph;
  const approvalToken = "approvalToken" in body && typeof body.approvalToken === "string" ? body.approvalToken : null;
  const idempotencyKey = "idempotencyKey" in body && typeof body.idempotencyKey === "string" ? body.idempotencyKey : null;

  // 1) Re-validate via S0 (`validateDeliveryGraph`) for a clean 400 BEFORE compiling — the door
  //    re-checks even though the compiler validates internally, so a malformed graph is refused at the
  //    edge with path-qualified errors and nothing is compiled or launched.
  const validationErrors = validateDeliveryGraph(graph);
  if (validationErrors.length > 0) {
    app.log.warn("start-delivery-graph rejected: validation", { count: validationErrors.length });
    return { status: 400, body: { ok: false, errors: validationErrors } };
  }

  // 2) Compile via S1. This yields the deterministic BPMN (→ the content digest / approval token) plus
  //    the graph's shape: its side effects (whether approval is required), human stops, and node count.
  const compiled = compileDeliveryGraph(graph);
  if (!compiled.ok) {
    app.log.warn("start-delivery-graph rejected: compile", { count: compiled.errors.length });
    return { status: 400, body: { ok: false, errors: compiled.errors } };
  }

  const digest = deliveryGraphDigest(compiled.bpmn);
  const runKey = computeRunKey(idempotencyKey, digest);
  const sideEffecting = compiled.sideEffects.length > 0;
  const title = typeof graph.name === "string" && graph.name.trim() !== "" ? graph.name.trim() : runKey;
  const runs = deliveryGraphRuns(app.data);

  // 3) Idempotency short-circuit — a re-POST onto a run that is still in flight does NOT double-launch.
  //    Only a `running` run short-circuits (`running` is neither terminal nor a parked-gate status): it
  //    returns `alreadyRunning`. A terminal (`done`/`failed`/`abandoned`) run may re-run, and an
  //    `awaiting-approval` run falls through to the approval gate below (this POST may now carry the
  //    token). Mirrors `startPlan`.
  const existing = await runs.get(runKey);
  if (existing && existing.status === "running") {
    app.log.info("start-delivery-graph short-circuit: already running", { runKey });
    // Report the ACTUALLY-running run's persisted metadata, not this request's. If a caller reused the
    // same `idempotencyKey` for a different graph, `digest`/`sideEffecting` derived from THIS submission
    // would mislabel the run that is really in flight — echo the winner row instead.
    return {
      status: 202,
      body: {
        ok: true,
        status: "running",
        runKey,
        digest: existing.digest,
        sideEffecting: existing.side_effecting === 1,
        alreadyRunning: true,
        processInstanceKey: existing.process_key ?? undefined,
        processDefinitionId: existing.process_definition_id ?? undefined,
      },
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
  const upsert = async (row: ReturnType<typeof buildDeliveryGraphRunRow>) => {
    if (existing) {
      const { run_key, created_at, ...patch } = row;
      await runs.update(runKey, patch);
      return;
    }
    try {
      await runs.insert(row);
    } catch (err) {
      // A concurrent submit won the `run_key` PK fence between our `get()` and this `insert` — collapse
      // onto the winner's row (idempotent) instead of surfacing the collision as a 500.
      if (!isUniqueConstraintFence(err)) throw err;
      const { run_key, created_at, ...patch } = row;
      await runs.update(runKey, patch);
    }
  };

  // 4) Approval gate (Decision 7) — a side-effecting graph without a valid approval token is REFUSED
  //    (400) and PARKED as an `awaiting-approval` run so it is visible in the cockpit; the response
  //    carries the token to re-submit with. A non-side-effecting graph passes straight through.
  if (!isDeliveryGraphApproved(sideEffecting, approvalToken, digest)) {
    await upsert(buildDeliveryGraphRunRow({ ...rowBase, status: "awaiting-approval", phase: DELIVERY_PHASE.AWAITING_APPROVAL, processKey: null }));
    app.log.info("start-delivery-graph parked: awaiting approval", { runKey, sideEffects: compiled.sideEffects.length });
    return {
      status: 400,
      body: {
        ok: false,
        status: "awaiting-approval",
        runKey,
        digest,
        sideEffecting,
        approvalToken: digest,
        message: `graph has ${compiled.sideEffects.length} side-effecting node(s); re-submit with approvalToken to dispatch`,
      },
    };
  }

  // 5) Claim the run durably BEFORE the side effect — mirrors `startPlan`, which writes the `plans`
  //    row before `engine.createInstance`. `claimRunForLaunch` makes the launch AT-MOST-ONCE under
  //    concurrent submits from EITHER starting state: a first launch is fenced by the `run_key` PK
  //    (a racing insert loses the unique constraint), and a relaunch off a persisted row (an approved
  //    parked row, or a re-run terminal row) is fenced by an atomic compare-and-swap that flips the
  //    row to `running` only if it is not already `running`. The loser never reaches `runDeliveryGraph`
  //    — it re-reads the winner's row and short-circuits as `alreadyRunning` instead of double-launching
  //    a graph's side effects. The claimed row carries no `process_key` yet — like a freshly-inserted
  //    `planning` plan it is a transient active row that `pollDeliveryGraphPhase` and the instanceTracking
  //    reconciler skip until the instance key lands (both ignore null-key rows).
  const claim = buildDeliveryGraphRunRow({ ...rowBase, status: "running", phase: DELIVERY_PHASE.RUNNING, processKey: null });
  const wonClaim = await claimRunForLaunch(app.data, Boolean(existing), claim);
  if (!wonClaim) {
    const won = await runs.get(runKey);
    app.log.info("start-delivery-graph short-circuit: launch claim raced a concurrent submit", { runKey });
    // Echo the winner row's persisted metadata (falling back to this request's only if the row
    // somehow can't be re-read) so a reused idempotencyKey never reports the wrong run's digest.
    return {
      status: 202,
      body: {
        ok: true,
        status: "running",
        runKey,
        digest: won?.digest ?? digest,
        sideEffecting: won ? won.side_effecting === 1 : sideEffecting,
        alreadyRunning: true,
        processInstanceKey: won?.process_key ?? undefined,
        processDefinitionId: won?.process_definition_id ?? undefined,
      },
    };
  }
  // Won the claim. For a relaunch off a persisted row the guarded CAS flipped only `status`; write the
  // run's full metadata now — we are the sole caller past the fence, so this update cannot race.
  if (existing) {
    const { run_key, created_at, ...patch } = claim;
    await runs.update(runKey, patch);
  }

  // 6) Launch — deploy + start the compiled definition via the S4 runner. `runKey` scopes the run's
  //    wait-gate keys so two runs of the same graph never cross-correlate. On ANY launch failure (a
  //    thrown engine error OR the runner's `ok:false`) flip the claimed row to `failed` so no null-
  //    process_key `running` row is ever stranded — the reconciler and poller both skip null-key rows,
  //    so a stranded claim would otherwise never terminate — then surface the error.
  const markClaimFailed = async () => {
    const failed = buildDeliveryGraphRunRow({ ...rowBase, status: "failed", phase: DELIVERY_PHASE.FAILED, processKey: null });
    const { run_key, created_at, ...patch } = failed;
    await runs.update(runKey, patch);
  };
  let launched: Awaited<ReturnType<typeof runDeliveryGraph>>;
  try {
    launched = await runDeliveryGraph(app.engine, graph, { runKey });
  } catch (err) {
    await markClaimFailed();
    app.log.error("start-delivery-graph launch threw", { runKey });
    throw err;
  }
  if (!launched.ok) {
    await markClaimFailed();
    app.log.error("start-delivery-graph launch failed", { runKey, count: launched.errors.length });
    return { status: 400, body: { ok: false, errors: launched.errors } };
  }
  // 7) Stamp the started instance key onto the claimed row.
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
    status: 202,
    body: {
      ok: true,
      status: "running",
      runKey,
      digest,
      sideEffecting,
      alreadyRunning: false,
      processInstanceKey: launched.handle.processInstanceKey,
      processDefinitionId: launched.handle.processDefinitionId,
    },
  };
});
