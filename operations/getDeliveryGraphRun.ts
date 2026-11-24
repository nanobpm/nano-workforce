// GET /app/api/delivery-graph/runs/{runKey} → operationId `getDeliveryGraphRun` (issue #1055).
// `d8ctl nwf graph progress <runKey>`: the per-node progress of a dispatched delivery-graph run —
// each node's state (pending | active | satisfied | escalated | skipped | failed), the elements holding
// a token, a wait's last probe result and poll cadence, the facts the node bound (e.g. an agent's
// `pr`), the child PR run keys, and any open escalation / incident — derived at request time from the
// engine (element instances, variables, user tasks, incidents) by `loadDeliveryGraphProgress`
// (app/deliveryGraphProgress.ts). Read-only.
//
// The optional shared-secret guard mirrors `getStagedProposal`.
import { loadDeliveryGraphProgress } from "../app/deliveryGraphProgress.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("getDeliveryGraphRun", async ({ req, params }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("getDeliveryGraphRun rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  const runKey = typeof params.runKey === "string" ? params.runKey.trim() : "";
  const progress = runKey === "" ? null : await loadDeliveryGraphProgress(app, runKey);
  if (!progress) {
    return { status: 404, body: { error: `no delivery-graph run with key ${runKey}` } };
  }
  return { status: 200, body: progress };
});
