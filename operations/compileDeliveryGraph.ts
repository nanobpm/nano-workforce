// POST /app/api/actions/compile-delivery-graph → operationId `compileDeliveryGraph` (ADR 0005,
// slice S1). The PURE, side-effect-free compile door: the fast, safe inner loop a co-designing agent
// hammers while authoring a `DeliveryGraph`. It VALIDATES (the pure `validateDeliveryGraph` semantic
// check, run inside the compiler) and COMPILES the graph into a preview — the compiled one-shot BPMN
// (compile-to-native), a mermaid diagram, the resolved/normalised graph, and the extracted human
// stop-points + side effects — but NEVER deploys, dispatches, or mutates anything (Decision 5/6:
// `compile` and `start` are SEPARATE doors, and there is deliberately no `dryRun` flag on the start
// door). Because it has zero side effects, an agent may call it repeatedly: JSON → compile → fix.
//
// A well-formed graph is `200 { ok:true, diagram, bpmn, resolved, humanNodes, sideEffects }`; a
// malformed one is `400 { ok:false, errors:[{ path, message }] }`, every error path-qualified so the
// author can fix the exact offending input. The compiler is the single source of both truths — this
// delegate just maps its discriminated result onto the HTTP status.

import { compileDeliveryGraph } from "../app/deliveryGraphCompiler.ts";
import { defineOperation } from "../nano-generated/operations.ts";

export default defineOperation("compileDeliveryGraph", async ({ body }, app) => {
  // The runtime validates the body's SHAPE against `DeliveryGraph` before we run; the compiler adds
  // the SEMANTIC checks (acyclicity, edge integrity, fact resolution) the schema cannot express. A
  // directly-invoked delegate could still pass `undefined` — the compiler reads its input as
  // `unknown` and maps that to a clean `ok:false`, never a 500.
  const result = await compileDeliveryGraph(body);
  if (!result.ok) {
    app.log.warn("compile-delivery-graph rejected", { errors: result.errors.length });
    return { status: 400, body: result };
  }
  app.log.info("compile-delivery-graph compiled", {
    nodes: result.resolved.nodes.length,
    edges: result.resolved.edges.length,
    humanNodes: result.humanNodes.length,
    sideEffects: result.sideEffects.length,
  });
  return { status: 200, body: result };
});
