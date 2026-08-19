// POST /app/api/actions/acknowledge-epic → operationId `acknowledgeEpic` (issue #298).
// The nwf UI's "Dismiss" affordance for a RESOLVED epic: an operator dismisses a `done` epic whose
// fan-out has finished (all slice PRs reached a terminal state — whether all merged/landed or
// resolved-not-landed) directly from the Epic / Overview pages so it drops out of the Active epic list
// into History. It is the epic twin of `acknowledgeDone` (the feature-run tick-off) — a resolved epic
// is NOT parked at a user task, so this op completes no user task and touches no engine/ledger: it
// simply stamps `acknowledged_at` on the `plans` row via the plans gateway.
//
// The gateway (app/plan.ts) recomputes `list_bucket`/`ack_open` on that write — a landed, now-
// acknowledged epic flips `list_bucket` to 'history' and `ack_open` to 0 — so this op NEVER hand-sets
// a derived projection. Keyed on the row's `plan_key`. Idempotent-safe: re-acknowledging re-stamps
// the timestamp and keeps the row in History.
//
// It rejects (409) an epic that is NOT fully landed (`status=done, delivery=landed`), so it can never
// pre-seed the tick-off on a still-live or still-converging epic — those must stay visible in Active.

import { epicIsAcknowledgeable } from "../app/delivery.ts";
import { plans } from "../app/plan.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export default defineOperation("acknowledgeEpic", async ({ body }, app) => {
  if (!body || typeof body !== "object") {
    app.log.warn("acknowledge-epic rejected: missing request body");
    return { status: 400, body: { ok: false, error: "plan_key is required" } };
  }

  const planKey = str(body.plan_key);
  if (!planKey) return { status: 400, body: { ok: false, error: "plan_key is required" } };

  const table = plans(app.data);
  const plan = await table.get(planKey);
  if (!plan) {
    app.log.warn("acknowledge-epic: no such plan", { planKey });
    return { status: 404, body: { ok: false, error: "no such epic" } };
  }

  // Guard: only a RESOLVED epic (`status=done` and no longer `converging`) carries the Dismiss
  // affordance. Acknowledging a live/converging epic would pre-seed `acknowledged_at`, so the moment
  // it later resolved `deriveEpicBucket` would drop it straight into History, skipping the operator
  // tick-off this op exists to require — and a converging epic must stay visible while its slices land.
  if (!epicIsAcknowledgeable(plan.status, plan.delivery ?? null)) {
    app.log.warn("acknowledge-epic rejected: epic is not resolved", {
      planKey,
      status: plan.status,
      delivery: plan.delivery ?? null,
    });
    return { status: 409, body: { ok: false, error: "epic is not resolved" } };
  }

  // Stamp the dismissal. The gateway recomputes `list_bucket` (→ 'history') and `ack_open` (→ 0) from
  // the merged row, so we never hand-set them here. Idempotent: re-acknowledging re-stamps and stays
  // in History.
  const now = new Date().toISOString();
  await table.update(planKey, { acknowledged_at: now, updated_at: now });

  app.log.info("operator dismissed resolved epic", { planKey });
  return { status: 200, body: { ok: true, message: "acknowledged" } };
});
