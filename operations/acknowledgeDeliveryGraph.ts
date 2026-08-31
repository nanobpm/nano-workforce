// POST /app/api/actions/acknowledge-delivery-graph → operationId `acknowledgeDeliveryGraph` (issue #641).
// The nwf UI's "Dismiss" (Done ✓) affordance for a TERMINAL delivery-graph run: an operator dismisses a
// finished run (done / failed / abandoned) directly from the Overview "Active Delivery Graphs" or
// delivery-graphs "In-flight delivery graphs" grid so it drops out of the Active list into History. It
// is the delivery-graph twin of `acknowledgeDone` / `acknowledgeEpic` / `acknowledgePr` — a terminal
// run is NOT parked at a user task, so this op completes no user task and touches no engine/ledger: it
// simply stamps `acknowledged_at` on the `delivery_graph_runs` row.
//
// `list_bucket`/`ack_open` are DERIVED by the `delivery_graph_read_model` VIEW (096, issue #641) from
// the terminal-folded `derived_status` + `acknowledged_at` — a terminal, now-acknowledged run reads
// `list_bucket` = 'history' and `ack_open` = 0 — so this op NEVER writes a derived projection. Keyed on
// the row's `run_key`. Idempotent-safe: re-acknowledging re-stamps the timestamp and keeps it in
// History.
//
// It rejects (409) a run that is NOT terminal (still awaiting-approval/running), so it can never pre-
// seed the tick-off on a live run. The terminal check reads the base `status`: the delivery-graph
// poller (app/deliveryGraphRun.ts) persists the terminal outcome to base `status` (done/failed/
// abandoned), and the reconciler's `onTerminated` edge covers an out-of-band terminate.

import { DELIVERY_GRAPH_TERMINAL_STATUSES, deliveryGraphRuns } from "../app/deliveryGraphRun.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export default defineOperation("acknowledgeDeliveryGraph", async ({ body }, app) => {
  if (!body || typeof body !== "object") {
    app.log.warn("acknowledge-delivery-graph rejected: missing request body");
    return { status: 400, body: { ok: false, error: "run_key is required" } };
  }

  const runKey = str(body.run_key);
  if (!runKey) return { status: 400, body: { ok: false, error: "run_key is required" } };

  const table = deliveryGraphRuns(app.data);
  const run = await table.get(runKey);
  if (!run) {
    app.log.warn("acknowledge-delivery-graph: no such run", { runKey });
    return { status: 404, body: { ok: false, error: "no such delivery-graph run" } };
  }

  // Guard: only a TERMINAL run (a `DELIVERY_GRAPH_TERMINAL_STATUSES` status — the same set the read
  // model's `list_bucket` folds to History) carries the Dismiss affordance. Acknowledging a live run
  // would pre-seed `acknowledged_at`, so the moment it later settled the VIEW would drop it straight
  // into History, skipping the operator tick-off this op exists to require.
  if (!DELIVERY_GRAPH_TERMINAL_STATUSES.includes(run.status)) {
    app.log.warn("acknowledge-delivery-graph rejected: run is not terminal", { runKey, status: run.status });
    return { status: 409, body: { ok: false, error: "delivery-graph run is not terminal" } };
  }

  // Stamp the dismissal. `list_bucket` (→ 'history') and `ack_open` (→ 0) are derived by the
  // `delivery_graph_read_model` VIEW from the terminal, now-acknowledged row, so we never hand-set them
  // here. Idempotent: re-acknowledging re-stamps and stays in History.
  const now = new Date().toISOString();
  await table.update(runKey, { acknowledged_at: now, updated_at: now });

  app.log.info("operator dismissed terminal delivery-graph run", { runKey });
  return { status: 200, body: { ok: true, message: "acknowledged" } };
});
