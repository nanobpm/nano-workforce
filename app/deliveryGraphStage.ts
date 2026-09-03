// nano-workforce — the ONE compile-and-stage flow shared by every agent-facing door that stages a
// delivery graph (epic nano-workforce#605). Extracted from `operations/compileDeliveryGraph.ts` (S0)
// so the intent-shaped generator doors (S4 — `sequenceIssues`) hand their CONSTRUCTED graph to the
// EXACT same deterministic compile → validate → stage path the raw `compileDeliveryGraph` door uses:
// one compiler (`compileDeliveryGraph`), one staging path (`stageProposal`), one idempotency/digest
// semantics (content-addressed by `deliveryGraphDigest`). Per AGENTS.md "Derivation over duplication:
// no drift surfaces", a generator MUST NOT re-implement a second runner or a second staging path —
// it only produces the `DeliveryGraph` and delegates here.
//
// The result mirrors the `compileDeliveryGraph` operation's wire contract exactly: a `200` carrying
// the `CompileDeliveryGraphStaged` preview + navigational `reviewUrl` (NO dispatch handle — dispatch
// stays an operator-only cockpit action, ADR 0005 Decision 7 / issue #460), or a `400` carrying the
// `CompileDeliveryGraphErrors` `{ ok:false, errors:[{path,message}] }` when the graph fails shape or
// semantic validation. Nothing is staged on a rejected compile.
import type { DataLayer } from "@nanobpm/urban";
import type { CompileDeliveryGraphErrors, CompileDeliveryGraphStaged } from "../nano-generated/api-io.d.ts";
import { compileDeliveryGraphSemantic } from "./deliveryGraphCompiler.ts";
import {
  buildProposalPreview,
  buildProposalRow,
  proposalLogicalKey,
  proposalReviewUrl,
  stageProposal,
} from "./deliveryGraphProposals.ts";
import { deliveryGraphDigest } from "./deliveryRunner.ts";

/** The human-readable instruction every staged compile hands back — the agent's surface ends here;
 * dispatch is an operator action and there is no start endpoint (capability-by-absence, #460). */
export const STAGED_MESSAGE =
  "The graph compiled and is staged for operator review. Ask the operator to preview and approve — or request modifications — in the cockpit. Dispatch is an operator action; there is no start endpoint.";

/** A successful stage — the `CompileDeliveryGraphStaged` body plus the compiled `digest` and node
 * counts, so a caller can log what it staged without re-deriving them. */
export interface StagedResult {
  ok: true;
  status: 200;
  body: CompileDeliveryGraphStaged;
  digest: string;
  nodeCount: number;
  humanNodeCount: number;
  sideEffectCount: number;
}

/** A rejected compile — the `CompileDeliveryGraphErrors` body, verbatim from the compiler. */
export interface StageErrors {
  ok: false;
  status: 400;
  body: CompileDeliveryGraphErrors;
}

/**
 * Compile a `DeliveryGraph` and, when valid, persist it as a `staged` proposal — the single
 * compile+stage flow (see the module header). `graph` is the structured `DeliveryGraph` object (an
 * agent-authored one from `compileDeliveryGraph`, or a generator-CONSTRUCTED one from a `start/*`
 * intent door); `graphJson` is the serialised form persisted on the proposal row for the cockpit
 * dispatch to re-run (the caller supplies it so a generator can persist the SAME object it compiled,
 * byte-for-byte). `origin` is the public origin the request arrived on, used to build the
 * navigational `reviewUrl`. Never dispatches; never throws for a malformed graph (the compiler maps
 * unknown input to a clean `ok:false`).
 */
export async function compileAndStageDeliveryGraph(
  data: DataLayer,
  graph: unknown,
  graphJson: string,
  origin: string,
): Promise<StagedResult | StageErrors> {
  const result = await compileDeliveryGraphSemantic(graph);
  if (!result.ok) {
    return { ok: false, status: 400, body: result };
  }

  const digest = deliveryGraphDigest(result.semanticBpmn);
  const name =
    typeof result.resolved.name === "string" && result.resolved.name.trim() !== ""
      ? result.resolved.name.trim()
      : null;
  const preview = buildProposalPreview(result);
  await stageProposal(
    data,
    buildProposalRow({
      digest,
      logicalKey: proposalLogicalKey(name, digest),
      title: name,
      graphJson,
      preview,
      nodeCount: result.resolved.nodes.length,
      humanNodeCount: result.humanNodes.length,
      sideEffectCount: result.sideEffects.length,
      sideEffecting: result.sideEffects.length > 0,
    }),
  );

  return {
    ok: true,
    status: 200,
    body: {
      status: "ready",
      message: STAGED_MESSAGE,
      digest,
      preview,
      reviewUrl: proposalReviewUrl(digest, origin),
    },
    digest,
    nodeCount: result.resolved.nodes.length,
    humanNodeCount: result.humanNodes.length,
    sideEffectCount: result.sideEffects.length,
  };
}
