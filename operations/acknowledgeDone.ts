// POST /app/api/actions/acknowledge-done → operationId `acknowledgeDone` (issue #254 §5; generalised by
// #654). The nwf UI's "tick off" affordance for a TERMINAL feature run: an operator dismisses a
// finished run (Done ✓ / Done ✕) directly from the Feature / Overview pages so it drops out of the
// primary Active list into History. A terminal run is NOT parked at a user task, so this op completes
// no user task and touches no engine/ledger: it simply stamps `acknowledged_at` on the `feature_runs`
// row. The DONE twin of `acknowledgePr` / `acknowledgeDeliveryGraph` / `acknowledgeEpic`.
//
// This op is now a one-liner over the shared `acknowledgeVia` helper (issue #654), which gates on the
// `feature_read_model` VIEW's derived `ack_open` (added by migration 099) — the SAME oracle the Dismiss
// button reads via `showWhenField` — so the affordance and the guard cannot drift. This retires the
// old base-`status` guard (`STAGE_DONE_STATUSES.includes(run.status)`), a latent twin of the PR drift
// (#652): a feature run terminated out-of-band froze base `status` at `running`/`escalated` while the
// tracking VIEW folded `derived_status='abandoned'`, so the button offered Dismiss but the op 409'd.
// The guard now reads the terminal-folded `ack_open`, never the base `status`.

import { acknowledgeVia } from "../app/acknowledge.ts";
import { featureReadModel } from "../app/featureReadModel.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export default defineOperation("acknowledgeDone", async ({ body }, app) => {
  if (!body || typeof body !== "object") {
    app.log.warn("acknowledge-done rejected: missing request body");
    return { status: 400, body: { ok: false, error: "feature_key is required" } };
  }

  const featureKey = str(body.feature_key);
  if (!featureKey) return { status: 400, body: { ok: false, error: "feature_key is required" } };

  return acknowledgeVia(
    app,
    {
      view: featureReadModel.decl.name,
      baseTable: "feature_runs",
      keyColumn: "feature_key",
      label: "feature run",
      notDismissableError: "feature run is not terminal",
    },
    featureKey,
  );
});
