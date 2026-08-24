// POST /app/api/actions/delivery-graph/stage → operationId `stageDeliveryGraph` (ADR 0005 Decision 7,
// issues #460 + #516). The human-facing UI JSON-paste STAGE ingress: the Delivery Graphs page's
// "Stage" action posts the operator's pasted delivery-graph as a raw JSON STRING; this door parses it,
// runs the SAME `compileDeliveryGraph` compiler the preview/agent doors use, and — on success —
// persists the compiled graph as a `staged` proposal (content-addressed by its `digest`) for an
// operator to dispatch from the Staged proposals grid.
//
// It is the STAGE half of the preview/stage split (#516): preview (`previewDeliveryGraph`) compiles
// WITHOUT persisting; this door is the deliberate commit step. It never deploys or dispatches —
// dispatch is a separate OPERATOR action on the staged proposal (the Dispatch button on the
// staged-proposals grid, #460). A blank/invalid JSON string, or a graph that fails validation, is a
// 400 carrying a human `error` (and path-qualified `errors` for a compile failure); nothing is staged.

import {
  buildProposalPreview,
  buildProposalRow,
  proposalLogicalKey,
  stageProposal,
} from "../app/deliveryGraphProposals.ts";
import { buildTextPreviewBody, parseAndCompileText } from "../app/deliveryGraphTextIngress.ts";
import { defineOperation } from "../nano-generated/operations.ts";

export default defineOperation("stageDeliveryGraph", async ({ body }, app) => {
  const ingress = await parseAndCompileText(body);
  if (!ingress.ok) {
    app.log.warn("stage-delivery-graph rejected", { message: ingress.body.error });
    return { status: ingress.status, body: ingress.body };
  }

  const { compiled, digest, name, graph } = ingress;
  await stageProposal(
    app.data,
    buildProposalRow({
      digest,
      logicalKey: proposalLogicalKey(name, digest),
      title: name,
      graphJson: JSON.stringify(graph),
      preview: buildProposalPreview(compiled),
      nodeCount: compiled.resolved.nodes.length,
      humanNodeCount: compiled.humanNodes.length,
      sideEffectCount: compiled.sideEffects.length,
      sideEffecting: compiled.sideEffects.length > 0,
    }),
  );

  app.log.info("stage-delivery-graph staged", {
    nodes: compiled.resolved.nodes.length,
    humanNodes: compiled.humanNodes.length,
    sideEffects: compiled.sideEffects.length,
    digest,
  });
  return { status: 200, body: buildTextPreviewBody(ingress, { staged: true }) };
});
