// GET /app/api/delivery-graph/staged → operationId `listStagedProposals` (issue #511). The read behind
// the staged-proposals App-View: every LIVE `staged` delivery-graph proposal (not aged out of its TTL),
// newest first, projected to the metadata the Preview-DI + Dispatch list renders.
//
// It replaces the declarative `dataGrid` datasource the staged grid used, so the list can live in an
// App-View (JS) that CAN drive the `nano-navigate` DI-preview bridge — a declarative grid row-action
// can POST but cannot hand the recompiled BPMN up to the host explorer. The `graph`/`preview` payloads
// are deliberately omitted: the App-View recompiles by `digest` through `previewProposalBpmn` for the DI
// preview, so the list stays lean.
//
// The optional shared-secret guard stays HERE (the runtime does not enforce OpenAPI `security`): when
// NANO_PR_WEBHOOK_SECRET is set, callers must present it via the x-hook-secret header — mirroring the
// other read doors (getLineage / listActivePrs).
import { listStagedProposals } from "../app/deliveryGraphProposals.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("listStagedProposals", async ({ req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("listStagedProposals rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  const rows = await listStagedProposals(app.data);
  const proposals = rows.map((row) => ({
    digest: row.digest,
    title: row.title,
    nodeCount: row.node_count,
    humanNodeCount: row.human_node_count,
    sideEffectCount: row.side_effect_count,
    sideEffecting: row.side_effecting === 1,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }));
  return { status: 200, body: { count: proposals.length, proposals } };
});
