// POST /app/api/actions/delivery-graph/preview → operationId `previewDeliveryGraph` (ADR 0005
// Decision 7, issue #460). The human-facing UI JSON-paste PREVIEW+STAGE ingress: the Delivery Graphs
// page's "Preview & stage" action posts the operator's pasted delivery-graph as a raw JSON STRING;
// this door parses it (`parseDeliveryGraphText`) and runs the SAME `compileDeliveryGraph` compiler the
// agent-facing door uses, and — like the agent compile door — persists the compiled graph as a
// `staged` proposal (content-addressed by its `digest`).
//
// It returns a compact preview summary (the `digest`, node/human/side-effect counts, the mermaid
// `diagram`, and the full human-stop / side-effect detail) plus a navigational `reviewUrl`. It never
// deploys or dispatches — dispatch is a separate OPERATOR action on the staged proposal (the Dispatch
// button on the staged-proposals grid). A blank/invalid paste, or a graph that fails validation, is a
// 400 carrying a human `error` (and path-qualified `errors` for a compile failure); nothing is staged.

import { compileDeliveryGraph } from "../app/deliveryGraphCompiler.ts";
import {
  buildProposalPreview,
  buildProposalRow,
  proposalLogicalKey,
  proposalReviewUrl,
  stageProposal,
} from "../app/deliveryGraphProposals.ts";
import { parseDeliveryGraphText } from "../app/deliveryGraphText.ts";
import { deliveryGraphDigest } from "../app/deliveryRunner.ts";
import { defineOperation } from "../nano-generated/operations.ts";

export default defineOperation("previewDeliveryGraph", async ({ body }, app) => {
  const parsed = parseDeliveryGraphText(body);
  if (!parsed.ok) {
    app.log.warn("preview-delivery-graph rejected: parse", { message: parsed.error });
    return { status: 400, body: { ok: false, error: parsed.error } };
  }
  const compiled = await compileDeliveryGraph(parsed.graph);
  if (!compiled.ok) {
    app.log.warn("preview-delivery-graph rejected: compile", { errors: compiled.errors.length });
    return {
      status: 400,
      body: {
        ok: false,
        error: `graph failed validation: ${compiled.errors.length} error(s)`,
        errors: compiled.errors,
      },
    };
  }

  const digest = deliveryGraphDigest(compiled.bpmn);
  const name =
    typeof compiled.resolved.name === "string" && compiled.resolved.name.trim() !== ""
      ? compiled.resolved.name.trim()
      : null;
  const preview = buildProposalPreview(compiled);
  await stageProposal(
    app.data,
    buildProposalRow({
      digest,
      logicalKey: proposalLogicalKey(name, digest),
      title: name,
      graphJson: JSON.stringify(parsed.graph),
      preview,
      nodeCount: compiled.resolved.nodes.length,
      humanNodeCount: compiled.humanNodes.length,
      sideEffectCount: compiled.sideEffects.length,
      sideEffecting: compiled.sideEffects.length > 0,
    }),
  );

  app.log.info("preview-delivery-graph staged", {
    nodes: compiled.resolved.nodes.length,
    humanNodes: compiled.humanNodes.length,
    sideEffects: compiled.sideEffects.length,
    digest,
  });
  return {
    status: 200,
    body: {
      ok: true,
      staged: true,
      digest,
      reviewUrl: proposalReviewUrl(digest),
      ...(name !== null ? { title: name } : {}),
      sideEffecting: compiled.sideEffects.length > 0,
      nodeCount: compiled.resolved.nodes.length,
      humanNodeCount: compiled.humanNodes.length,
      sideEffectCount: compiled.sideEffects.length,
      diagram: compiled.diagram,
      // The FULL extracted preview detail (not just the counts): the human stop-points and the
      // side-effecting actions. The Delivery Graphs page renders these so the operator sees WHERE it
      // parks on a person and WHAT it will do — the "preview before dispatch" principle made visible.
      humanNodes: compiled.humanNodes,
      sideEffects: compiled.sideEffects,
    },
  };
});
