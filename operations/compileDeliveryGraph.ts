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

import { compileAndStageDeliveryGraph } from "../app/deliveryGraphStage.ts";
import { resolvePublicOrigin } from "../app/resolveApiBase.ts";
import { defineOperation } from "../nano-generated/operations.ts";

export default defineOperation("compileDeliveryGraph", async ({ body, req }, app) => {
  // The runtime validates the body's SHAPE against `DeliveryGraph` before we run; the shared
  // compile+stage flow adds the SEMANTIC checks (acyclicity, edge integrity, fact resolution) and,
  // when valid, persists the compiled graph as a `staged` proposal. A directly-invoked delegate could
  // still pass `undefined` — the compiler reads its input as `unknown` and maps that to a clean
  // `ok:false`, never a 500. The navigational `reviewUrl` is keyed to the ORIGIN this request arrived
  // on (tunnel, proxy prefix, …), not the static deployment-wide NANO_WORKFORCE_BASE_URL, so the
  // operator driving this instance can actually open it (#577).
  const staged = await compileAndStageDeliveryGraph(
    app.data,
    body,
    JSON.stringify(body),
    resolvePublicOrigin(req),
  );
  if (!staged.ok) {
    app.log.warn("compile-delivery-graph rejected", { errors: staged.body.errors.length });
    return { status: 400, body: staged.body };
  }

  app.log.info("compile-delivery-graph staged", {
    digest: staged.digest,
    nodes: staged.nodeCount,
    humanNodes: staged.humanNodeCount,
    sideEffects: staged.sideEffectCount,
  });

  // The response carries a preview + a navigational pointer and NO dispatch handle (issue #460).
  return { status: staged.status, body: staged.body };
});
