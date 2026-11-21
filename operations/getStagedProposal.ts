// GET /app/api/delivery-graph/staged/{digest} → operationId `getStagedProposal` (issue #989).
// `d8ctl nwf graph show <digest>`: the per-step summary of ONE live staged delivery-graph proposal an
// operator reviews before `graph dispatch` — kind/type, target, dependencies, guard, effective time
// limit, on-timeout, converge/auto-merge. The step facts are derived by `summarizeDeliverySteps`
// (app/deliveryRunner.ts) from the SAME defaults the dispatch runner seeds, so this is what a dispatch
// would run, without grepping the compiled BPMN. Read-only.
//
// The optional shared-secret guard mirrors `listStagedProposals`.
import { getStagedProposal } from "../app/deliveryGraphProposals.ts";
import { summarizeDeliverySteps } from "../app/deliveryRunner.ts";
import { envVar } from "../app/version.ts";
import type { DeliveryGraph } from "../nano-generated/api-io.d.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("getStagedProposal", async ({ req, params }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("getStagedProposal rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  const digest = typeof params.digest === "string" ? params.digest.trim() : "";
  const proposal = digest === "" ? null : await getStagedProposal(app.data, digest);
  if (!proposal) {
    return {
      status: 404,
      body: { error: `no live staged proposal for digest ${digest} — it may have been dispatched, superseded, or aged out` },
    };
  }
  // The stored graph passed `validateDeliveryGraph` at stage time, so it is a well-formed DeliveryGraph.
  const graph: DeliveryGraph = JSON.parse(proposal.graph);
  return {
    status: 200,
    body: {
      digest: proposal.digest,
      title: proposal.title,
      nodeCount: proposal.node_count,
      createdAt: proposal.created_at,
      expiresAt: proposal.expires_at,
      steps: summarizeDeliverySteps(graph),
    },
  };
});
