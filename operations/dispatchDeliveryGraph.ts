// POST /app/api/actions/delivery-graph/dispatch → operationId `dispatchDeliveryGraph` (ADR 0005
// Decision 7, issue #460). The OPERATOR-ONLY dispatch door: the cockpit's staged-proposals grid posts
// the `digest` of the proposal the operator picked; this door loads that `staged` proposal, runs the
// retained S4 runner for its previewed graph (`dispatchDeliveryGraphRun`), and marks the proposal
// `dispatched`.
//
// The operator clicking Dispatch IS the approval — there is no replayable token. This door is NOT part
// of the agent surface: the agent compile door returns only a navigational preview (no digest-as-
// dispatch-handle), so an agent cannot reach a run through the documented surface. Idempotent: a
// re-dispatch of an already-running run short-circuits with `alreadyRunning`. An unknown / expired /
// superseded / already-dispatched digest is a clean 400.

import { dispatchDeliveryGraphRun } from "../app/deliveryGraphDispatch.ts";
import { getStagedProposal, markProposalDispatched } from "../app/deliveryGraphProposals.ts";
import type { DeliveryGraphTextResult } from "../nano-generated/api-io.d.ts";
import { defineOperation } from "../nano-generated/operations.ts";

export default defineOperation("dispatchDeliveryGraph", async ({ body }, app) => {
  const digest = body && typeof body === "object" && "digest" in body && typeof body.digest === "string" ? body.digest.trim() : "";
  if (digest === "") {
    app.log.warn("dispatch-delivery-graph rejected: missing digest");
    return { status: 400, body: { ok: false, error: "request body must carry a `digest` naming the staged proposal to dispatch" } };
  }
  const idemRaw = body && typeof body === "object" && "idempotencyKey" in body && typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  const idempotencyKey = idemRaw !== "" ? idemRaw : undefined;

  // Load the live staged proposal for this digest — refuses an unknown/expired/superseded/already-
  // dispatched digest cleanly (no run is launched).
  const proposal = await getStagedProposal(app.data, digest);
  if (!proposal) {
    app.log.warn("dispatch-delivery-graph rejected: no live staged proposal", { digest });
    return {
      status: 400,
      body: { ok: false, error: `no staged proposal for digest ${digest} — it may have been dispatched, superseded, or aged out; recompile to re-stage it` },
    };
  }

  // The stored graph was validated at stage time; dispatch re-compiles it to derive the run-row shape.
  let graph: unknown;
  try {
    graph = JSON.parse(proposal.graph);
  } catch (err) {
    app.log.error("dispatch-delivery-graph: stored graph is corrupt", { digest });
    return { status: 400, body: { ok: false, error: `staged proposal ${digest} is corrupt: ${err instanceof Error ? err.message : String(err)}` } };
  }

  const dispatched = await dispatchDeliveryGraphRun(app, graph, { runKey: idempotencyKey, title: proposal.title });
  if (!dispatched.ok) {
    app.log.warn("dispatch-delivery-graph refused: compile", { digest, errors: dispatched.errors.length });
    const outBody: DeliveryGraphTextResult = {
      ok: false,
      error: `graph failed validation: ${dispatched.errors.length} error(s)`,
      errors: dispatched.errors,
    };
    return { status: 400, body: outBody };
  }

  // Retire the proposal from the staged list — the run now shows in the in-flight grid.
  await markProposalDispatched(app.data, digest);

  const outBody: DeliveryGraphTextResult = {
    ok: true,
    status: dispatched.status,
    runKey: dispatched.runKey,
    digest: dispatched.digest,
    sideEffecting: dispatched.sideEffecting,
    alreadyRunning: dispatched.alreadyRunning,
  };
  if (dispatched.processInstanceKey !== undefined) outBody.processInstanceKey = dispatched.processInstanceKey;
  if (dispatched.processDefinitionId !== undefined) outBody.processDefinitionId = dispatched.processDefinitionId;
  return { status: 202, body: outBody };
});
