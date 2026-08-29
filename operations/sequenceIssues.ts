// POST /app/api/actions/start/sequence-issues → operationId `sequenceIssues` (epic
// nano-workforce#605, S4/#610). An INTENT-SHAPED door: instead of making an agent hand-author the
// full canonical node/edge JSON for "implement issue → converge → merge" (§9.4 — 13 nodes + 12 edges
// for four gated issues, in the evidence session), it takes the high-level intent
// `{ behind?, issues[] }` and GENERATES that canonical delivery graph, then hands it to the SAME
// compile+stage flow the raw `compileDeliveryGraph` door uses. It STAGES for operator review and
// returns a navigational `reviewUrl` and NOTHING that can trigger a run — dispatch stays an
// operator-only cockpit action (ADR 0005 Decision 7 / issue #460). No new runner, no second staging
// path: the generator only produces the `DeliveryGraph` (`buildSequenceGraph`) and delegates.
//
// Invalid input (empty `issues`, an unparseable `owner/repo#N` ref, an unknown target/probe per the
// S3 vocabulary) is a 400 carrying the uniform `issues[{path,message}]` contract; nothing is staged.
import { compileAndStageDeliveryGraph } from "../app/deliveryGraphStage.ts";
import { resolvePublicOrigin } from "../app/resolveApiBase.ts";
import { buildSequenceGraph } from "../app/sequenceIssues.ts";
import { defineOperation } from "../nano-generated/operations.ts";

export default defineOperation("sequenceIssues", async ({ body, req }, app) => {
  // Build the canonical graph from the intent. Input validation (shape, ref format, vocabulary drift)
  // lives in the pure `buildSequenceGraph` and returns the uniform `issues[{path,message}]` contract —
  // a directly-invoked delegate passing `undefined` folds into the same clean rejection.
  const built = buildSequenceGraph(body);
  if (!built.ok) {
    app.log.warn("sequence-issues rejected", { issues: built.issues.length });
    return { status: 400, body: { error: "invalid sequenceIssues intent", issues: built.issues } };
  }

  // Hand the CONSTRUCTED graph to the shared compile+stage flow — one compiler, one staging path,
  // idempotency/digest inherited (AGENTS.md "no drift surfaces"). `reviewUrl` keys to the origin this
  // request arrived on (tunnel/proxy prefix), not the static deployment-wide base (#577).
  const staged = await compileAndStageDeliveryGraph(
    app.data,
    built.graph,
    JSON.stringify(built.graph),
    resolvePublicOrigin(req),
  );
  if (!staged.ok) {
    // A generated graph is well-formed by construction; a compile failure here is a generator defect,
    // surfaced through the SAME `issues[{path,message}]` contract (mapped from the compiler's
    // path-qualified `errors`) rather than a 500.
    app.log.error("sequence-issues compile failed on a generated graph", { errors: staged.body.errors.length });
    return {
      status: 400,
      body: { error: "generated delivery graph failed to compile", issues: staged.body.errors },
    };
  }

  app.log.info("sequence-issues staged", {
    digest: staged.digest,
    nodes: staged.nodeCount,
    humanNodes: staged.humanNodeCount,
    sideEffects: staged.sideEffectCount,
  });
  return { status: staged.status, body: staged.body };
});
