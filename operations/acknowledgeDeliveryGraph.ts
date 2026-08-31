// POST /app/api/actions/acknowledge-delivery-graph → operationId `acknowledgeDeliveryGraph` (issue
// #641; generalised by #654). The nwf UI's "Dismiss" (Done ✓) affordance for a TERMINAL delivery-graph
// run: an operator dismisses a finished run (done / failed / abandoned) directly from the Overview
// "Active Delivery Graphs" or delivery-graphs "In-flight delivery graphs" grid so it drops out of the
// Active list into History. A terminal run is NOT parked at a user task, so this op completes no user
// task and touches no engine/ledger: it simply stamps `acknowledged_at` on the `delivery_graph_runs`
// row. The delivery-graph twin of `acknowledgeDone` / `acknowledgeEpic` / `acknowledgePr`.
//
// This op is now a one-liner over the shared `acknowledgeVia` helper (issue #654), which gates on the
// `delivery_graph_read_model` VIEW's derived `ack_open` — the SAME oracle the Dismiss button reads via
// `showWhenField` — so the affordance and the guard cannot drift. This retires the old base-`status`
// guard (`DELIVERY_GRAPH_TERMINAL_STATUSES.includes(run.status)`), a latent twin of the PR drift
// (#652): a run terminated out-of-band froze base `status` while the tracking VIEW folded
// `derived_status='abandoned'`, so the button offered Dismiss but the op 409'd. The guard now reads the
// terminal-folded `ack_open`, never the base `status`.

import { acknowledgeVia } from "../app/acknowledge.ts";
import { deliveryGraphReadModel } from "../app/deliveryGraphReadModel.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export default defineOperation("acknowledgeDeliveryGraph", async ({ body }, app) => {
  if (!body || typeof body !== "object") {
    app.log.warn("acknowledge-delivery-graph rejected: missing request body");
    return { status: 400, body: { ok: false, error: "run_key is required" } };
  }

  const runKey = str(body.run_key);
  if (!runKey) return { status: 400, body: { ok: false, error: "run_key is required" } };

  return acknowledgeVia(
    app,
    {
      view: deliveryGraphReadModel.decl.name,
      baseTable: "delivery_graph_runs",
      keyColumn: "run_key",
      label: "delivery-graph run",
      notDismissableError: "delivery-graph run is not terminal",
    },
    runKey,
  );
});
