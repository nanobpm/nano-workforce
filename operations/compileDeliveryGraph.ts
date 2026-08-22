// POST /app/api/actions/compile-delivery-graph → operationId `compileDeliveryGraph` (ADR 0005
// Decision 7, issue #460). The agent-facing delivery-graph door — and the END of the agent's surface.
// It VALIDATES (the pure `validateDeliveryGraph` semantic check, run inside the compiler) and COMPILES
// the graph, and when valid PERSISTS the compiled graph as a `staged` proposal (content-addressed by
// its `digest`). It returns a PREVIEW plus a navigational `reviewUrl` and NOTHING that can trigger a
// run: no run key, no token, no process-instance key.
//
// This is capability-by-absence (issue #460): the old two-step submit → token → re-submit flow made
// the "approval" a REPLAYABLE content digest handed back to the same caller, so any holder of the API
// credential self-approved. By removing the dispatch affordance from the agent surface entirely — there
// is no `start` endpoint — there is nothing to replay. Dispatch is an OPERATOR action performed in the
// cockpit; the response tells the agent its role ends here, turning the boundary into a self-documenting
// protocol. A malformed graph is a 400 carrying path-qualified errors; nothing is staged.

import { compileDeliveryGraph } from "../app/deliveryGraphCompiler.ts";
import {
  buildProposalPreview,
  buildProposalRow,
  proposalLogicalKey,
  proposalReviewUrl,
  stageProposal,
} from "../app/deliveryGraphProposals.ts";
import { deliveryGraphDigest } from "../app/deliveryRunner.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const STAGED_MESSAGE =
  "The graph compiled and is staged for operator review. Ask the operator to preview and approve — or request modifications — in the cockpit. Dispatch is an operator action; there is no start endpoint.";

export default defineOperation("compileDeliveryGraph", async ({ body }, app) => {
  // The runtime validates the body's SHAPE against `DeliveryGraph` before we run; the compiler adds
  // the SEMANTIC checks (acyclicity, edge integrity, fact resolution). A directly-invoked delegate
  // could still pass `undefined` — the compiler reads its input as `unknown` and maps that to a clean
  // `ok:false`, never a 500.
  const result = await compileDeliveryGraph(body);
  if (!result.ok) {
    app.log.warn("compile-delivery-graph rejected", { errors: result.errors.length });
    return { status: 400, body: result };
  }

  // Persist the compiled graph as a `staged` proposal — the agent's surface ends here. Superseded by
  // logical key + TTL inside `stageProposal`.
  const digest = deliveryGraphDigest(result.bpmn);
  const name =
    typeof result.resolved.name === "string" && result.resolved.name.trim() !== ""
      ? result.resolved.name.trim()
      : null;
  const preview = buildProposalPreview(result);
  await stageProposal(
    app.data,
    buildProposalRow({
      digest,
      logicalKey: proposalLogicalKey(name, digest),
      title: name,
      graphJson: JSON.stringify(body),
      preview,
      nodeCount: result.resolved.nodes.length,
      humanNodeCount: result.humanNodes.length,
      sideEffectCount: result.sideEffects.length,
      sideEffecting: result.sideEffects.length > 0,
    }),
  );

  app.log.info("compile-delivery-graph staged", {
    digest,
    nodes: result.resolved.nodes.length,
    humanNodes: result.humanNodes.length,
    sideEffects: result.sideEffects.length,
  });

  // The response carries a preview + a navigational pointer and NO dispatch handle (issue #460).
  return {
    status: 200,
    body: {
      status: "ready",
      message: STAGED_MESSAGE,
      digest,
      preview,
      reviewUrl: proposalReviewUrl(digest),
    },
  };
});
