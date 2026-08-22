// POST /app/api/actions/acknowledge-done → operationId `acknowledgeDone` (issue #254 §5).
// The nwf UI's "tick off" affordance for a TERMINAL feature run: an operator dismisses a finished
// run (Done ✓ / Done ✕) directly from the Feature / Overview pages so it drops out of the primary
// Active list into History. It is the DONE twin of `acknowledgeBlocked` — but a terminal run is NOT
// parked at a user task, so this op does NOT complete a user task and touches no engine/ledger: it
// simply stamps `acknowledged_at` on the row via the plain `feature_runs` record table (the projecting
// gateway this PR retired). It rejects (409) a run that
// is not yet truly terminal, so it can never pre-seed the tick-off on a still-live run.
//
// The `list_bucket` partition is DERIVED by the `feature_read_model` VIEW (073, issue #439) from
// `status` + `acknowledged_at` — a terminal row with `acknowledged_at` set reads as 'history' — so
// this op NEVER writes `list_bucket` (or any projection): stamping `acknowledged_at` is the whole
// contract. Keyed on the row's `feature_key`. Idempotent-safe: re-acknowledging simply re-stamps the
// timestamp and keeps the row in History.

import { featureRuns } from "../app/feature.ts";
import { STAGE_DONE_STATUSES } from "../app/stage.ts";
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

  // Guard: only a TRULY-terminal run (a `Done`-stage status — the same set `deriveListBucket` moves to
  // History) may be ticked off. Acknowledging a still-live run (e.g. `running`/`opened`/`converging`)
  // would pre-seed `acknowledged_at`, so the moment it later settles `deriveListBucket` would drop it
  // straight into History, skipping the operator tick-off this op exists to require.
  if (!STAGE_DONE_STATUSES.includes(run.status)) {
    app.log.warn("acknowledge-done rejected: run is not terminal", { featureKey, status: run.status });
    return { status: 409, body: { ok: false, error: "feature run is not terminal" } };
  }

  // Stamp the dismissal. `list_bucket` is derived by the `feature_read_model` VIEW (→ 'history' for a
  // terminal, acknowledged row), so we never hand-set it here. Idempotent: re-acknowledging re-stamps
  // and stays in History.
  const now = new Date().toISOString();
  await runs.update(featureKey, { acknowledged_at: now, updated_at: now });

  app.log.info("operator ticked off feature run", { featureKey });
  return { status: 200, body: { ok: true, message: "acknowledged" } };
});
