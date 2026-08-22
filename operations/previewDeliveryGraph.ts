// POST /app/api/actions/delivery-graph/preview → operationId `previewDeliveryGraph` (issue #386,
// ADR 0005 slice S1). The human-facing UI JSON-paste PREVIEW ingress: the Delivery Graphs page's
// "Preview" action posts the operator's pasted delivery-graph as a raw JSON STRING; this door parses
// it (`parseDeliveryGraphText`) and runs the SAME pure `compileDeliveryGraph` compiler the agent-facing
// door uses, returning a compact summary — the content `digest` (the approval token to dispatch with),
// the node / human-stop / side-effect counts, and the mermaid `diagram`.
//
// It is PURE and side-effect-free (compile and start are separate doors — Decision 5/7): nothing is
// deployed or dispatched, so an operator can Preview repeatedly while fixing the JSON. A blank/invalid
// paste, or a graph that fails validation, is a 400 carrying a human `error` (and, for a compile
// failure, the path-qualified `errors`). This is a thin UI adapter over the ONE compile contract, not
// a parallel compile path.

import { compileDeliveryGraph } from "../app/deliveryGraphCompiler.ts";
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
  app.log.info("preview-delivery-graph compiled", {
    nodes: compiled.resolved.nodes.length,
    humanNodes: compiled.humanNodes.length,
    sideEffects: compiled.sideEffects.length,
    digest,
  });
  return {
    status: 200,
    body: {
      ok: true,
      digest,
      ...(typeof compiled.resolved.name === "string" && compiled.resolved.name !== ""
        ? { title: compiled.resolved.name }
        : {}),
      sideEffecting: compiled.sideEffects.length > 0,
      nodeCount: compiled.resolved.nodes.length,
      humanNodeCount: compiled.humanNodes.length,
      sideEffectCount: compiled.sideEffects.length,
      diagram: compiled.diagram,
    },
  };
});
