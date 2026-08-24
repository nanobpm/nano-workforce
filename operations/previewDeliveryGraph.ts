// POST /app/api/actions/delivery-graph/preview → operationId `previewDeliveryGraph` (ADR 0005
// Decision 7, issues #460 + #516). The human-facing UI JSON-paste PURE PREVIEW ingress: the Delivery
// Graphs page's "Preview" action posts the operator's pasted delivery-graph as a raw JSON STRING; this
// door parses it (`parseDeliveryGraphText`) and runs the SAME `compileDeliveryGraph` compiler the
// agent-facing door uses — but, unlike the compile/stage doors, it does NOT persist anything. It is a
// side-effect-free compile: preview and STAGING are now separate operator actions (#516), so an
// operator can compile-and-inspect a graph (its diagram, human stop-points, side-effects) and iterate
// before committing it to the staged-proposals list via the separate "Stage" action (stageDeliveryGraph).
//
// It returns a compact preview summary (`staged:false`, the `digest`, node/human/side-effect counts,
// the mermaid `diagram`, the human stops and side effects) PLUS the compiled `bpmn` (with diagram
// interchange) so the page can render the laid-out BPMN in the host explorer WITHOUT staging. It never
// deploys or dispatches — dispatch is a separate operator action on a staged proposal. A blank/invalid
// JSON string, or a graph that fails validation, is a 400 carrying a human `error` (and path-qualified
// `errors` for a compile failure); nothing is compiled past the failure.

import { buildTextPreviewBody, parseAndCompileText } from "../app/deliveryGraphTextIngress.ts";
import { defineOperation } from "../nano-generated/operations.ts";

export default defineOperation("previewDeliveryGraph", async ({ body }, app) => {
  const ingress = await parseAndCompileText(body);
  if (!ingress.ok) {
    app.log.warn("preview-delivery-graph rejected", { message: ingress.body.error });
    return { status: ingress.status, body: ingress.body };
  }

  app.log.info("preview-delivery-graph compiled (not staged)", {
    nodes: ingress.compiled.resolved.nodes.length,
    humanNodes: ingress.compiled.humanNodes.length,
    sideEffects: ingress.compiled.sideEffects.length,
    digest: ingress.digest,
  });
  return { status: 200, body: buildTextPreviewBody(ingress, { staged: false, includeBpmn: true }) };
});
