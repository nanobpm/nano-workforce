// POST /app/api/actions/delivery-graph/proposal-bpmn → operationId `previewProposalBpmn`.
// The READ-ONLY DI preview door: the cockpit's staged-proposals grid posts the `digest` of the
// proposal the operator wants to look at, and this door recompiles that staged graph and hands back the
// compiled BPMN (with `bpmndi:BPMNDiagram`) so the host explorer can render the generated diagram
// interchange BEFORE dispatch.
//
// It is a PURE READ: no deploy, no dispatch, no instance — the compiler is deterministic (same graph →
// byte-identical BPMN → same digest), so we recompile the stored graph on demand rather than persisting
// the BPMN. As a determinism guard, the recompiled digest MUST equal the requested one; a mismatch means
// the stored graph and its content-address have drifted, which we surface as a 400 rather than serving a
// diagram that doesn't match the digest the operator is about to dispatch.
//
// An unknown / expired / superseded / already-dispatched digest, or a graph that no longer compiles, is a
// clean 400 (never a 500).

import { compileDeliveryGraph } from "../app/deliveryGraphCompiler.ts";
import { getStagedProposal } from "../app/deliveryGraphProposals.ts";
import { deliveryGraphDigest } from "../app/deliveryRunner.ts";
import type { DeliveryGraphProposalBpmnResult } from "../nano-generated/api-io.d.ts";
import { defineOperation } from "../nano-generated/operations.ts";

export default defineOperation("previewProposalBpmn", async ({ body }, app) => {
  const digest = typeof body?.digest === "string" ? body.digest.trim() : "";
  if (digest === "") {
    app.log.warn("preview-proposal-bpmn rejected: missing digest");
    return {
      status: 400,
      body: { ok: false, error: "request body must carry a `digest` naming the staged proposal to preview" },
    };
  }

  // Refuses an unknown / expired / superseded / already-dispatched digest cleanly.
  const proposal = await getStagedProposal(app.data, digest);
  if (!proposal) {
    app.log.warn("preview-proposal-bpmn rejected: no live staged proposal", { digest });
    return {
      status: 400,
      body: {
        ok: false,
        error: `no staged proposal for digest ${digest} — it may have been dispatched, superseded, or aged out; recompile to re-stage it`,
      },
    };
  }

  let graph: unknown;
  try {
    graph = JSON.parse(proposal.graph);
  } catch (err) {
    app.log.error("preview-proposal-bpmn: stored graph is corrupt", { digest });
    return {
      status: 400,
      body: { ok: false, error: `staged proposal ${digest} is corrupt: ${err instanceof Error ? err.message : String(err)}` },
    };
  }

  // Recompile the staged graph — the SAME pure compiler the agent/preview/dispatch doors use, so the
  // BPMN (and its DI) is identical to what a dispatch would deploy. No side effects.
  const compiled = await compileDeliveryGraph(graph);
  if (!compiled.ok) {
    app.log.warn("preview-proposal-bpmn: staged graph no longer compiles", { digest, errors: compiled.errors.length });
    return {
      status: 400,
      body: { ok: false, error: `staged proposal ${digest} failed to recompile: ${compiled.errors.length} error(s)` },
    };
  }

  // Determinism guard: the recompiled BPMN must content-address back to the requested digest. A mismatch
  // means the stored graph drifted from its digest — refuse rather than serve a diagram that doesn't
  // match the proposal the operator is about to dispatch.
  const recompiledDigest = deliveryGraphDigest(compiled.bpmn);
  if (recompiledDigest !== digest) {
    app.log.error("preview-proposal-bpmn: digest drift", { digest, recompiledDigest });
    return {
      status: 400,
      body: { ok: false, error: `staged proposal ${digest} recompiled to a different digest (${recompiledDigest}) — the stored graph has drifted; recompile to re-stage it` },
    };
  }

  app.log.info("preview-proposal-bpmn served", { digest, bytes: compiled.bpmn.length });
  const out: DeliveryGraphProposalBpmnResult = { ok: true, digest, bpmn: compiled.bpmn };
  return { status: 200, body: out };
});
