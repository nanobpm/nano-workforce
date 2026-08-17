// POST /app/api/actions/acknowledge-done → operationId `acknowledgeDone` (issue #254 §5).
// The nwf UI's "tick off" affordance for a TERMINAL feature run: an operator dismisses a finished
// run (Done ✓ / Done ✕) directly from the Feature / Overview pages so it drops out of the primary
// Active list into History. It is the DONE twin of `acknowledgeBlocked` — but a terminal run is NOT
// parked at a user task, so this op does NOT complete a user task and touches no engine/ledger: it
// simply stamps `acknowledged_at` on the row via the feature_runs gateway.
//
// The gateway (app/feature.ts) recomputes `list_bucket` on that write — a terminal row with
// `acknowledged_at` set flips to 'history' — so this op NEVER hand-sets `list_bucket` (or any other
// projection). Keyed on the row's `feature_key`. Idempotent-safe: re-acknowledging simply re-stamps
// the timestamp and keeps the row in History.

import { featureRuns } from "../app/feature.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export default defineOperation("acknowledgeDone", async ({ body }, app) => {
  if (!body || typeof body !== "object") {
    app.log.warn("acknowledge-done rejected: missing request body");
    return { status: 400, body: { ok: false, error: "feature_key is required" } };
  }

  const featureKey = str(body.feature_key);
  if (!featureKey) return { status: 400, body: { ok: false, error: "feature_key is required" } };

  const runs = featureRuns(app.data);
  const run = await runs.get(featureKey);
  if (!run) {
    app.log.warn("acknowledge-done: no such feature run", { featureKey });
    return { status: 404, body: { ok: false, error: "no such feature run" } };
  }

  // Stamp the dismissal. The gateway recomputes `list_bucket` from the merged row (→ 'history' for a
  // terminal run), so we never hand-set it here. Idempotent: re-acknowledging re-stamps and stays in
  // History.
  const now = new Date().toISOString();
  await runs.update(featureKey, { acknowledged_at: now, updated_at: now });

  app.log.info("operator ticked off feature run", { featureKey });
  return { status: 200, body: { ok: true, message: "acknowledged" } };
});
