// POST /app/api/actions/acknowledge-epic → operationId `acknowledgeEpic` (issue #298).
// The nwf UI's "Dismiss" affordance for a RESOLVED epic: an operator dismisses a `done` epic whose
// fan-out has finished (all slice PRs reached a terminal state — whether all merged/landed or
// resolved-not-landed) directly from the Epic / Overview pages so it drops out of the Active epic list
// into History. It is the epic twin of `acknowledgeDone` (the feature-run tick-off) — a resolved epic
// is NOT parked at a user task, so this op completes no user task and touches no engine/ledger: it
// simply stamps `acknowledged_at` on the `plans` row.
//
// `list_bucket`/`ack_open` are DERIVED by the `plan_read_model` VIEW (066, issue #439) from
// `status` + `acknowledged_at` + the derived `plan_delivery` signal — a landed, now-acknowledged epic
// reads `list_bucket` = 'history' and `ack_open` = 0 — so this op NEVER writes a derived projection.
// Keyed on the row's `plan_key`. Idempotent-safe: re-acknowledging re-stamps the timestamp and keeps
// the row in History.
//
// It rejects (409) an epic that is NOT yet resolved — i.e. anything the `epicIsAcknowledgeable`
// guard refuses: a non-`done` status (`planning`/`dispatched`), or `done` but still `converging`. A
// resolved epic is acknowledgeable whether all slices merged (`delivery=landed`) or it resolved-not-
// landed (`delivery=null`); only a still-live or still-converging epic is refused, so those stay
// visible in Active and can never pre-seed the tick-off.

import { epicIsAcknowledgeable } from "../app/delivery.ts";
import { plans } from "../app/plan.ts";
import { derivePlanDelivery } from "../app/service.ts";
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
  // The `plans.delivery` column was retired (epic #412), so derive the signal at read time from the
  // slice PRs (the same pure `deriveDelivery` the `plan_delivery` VIEW encodes).
  const delivery = await derivePlanDelivery(app.data, plan);
  if (!epicIsAcknowledgeable(plan.status, delivery)) {
    app.log.warn("acknowledge-epic rejected: epic is not resolved", {
      planKey,
      status: plan.status,
      delivery,
    });
    return { status: 409, body: { ok: false, error: "epic is not resolved" } };
  }

  // Stamp the dismissal. `list_bucket` (→ 'history') and `ack_open` (→ 0) are derived by the
  // `plan_read_model` VIEW from the resolved, now-acknowledged row, so we never hand-set them here.
  // Idempotent: re-acknowledging re-stamps and stays in History.
  const now = new Date().toISOString();
  await table.update(planKey, { acknowledged_at: now, updated_at: now });

  app.log.info("operator dismissed resolved epic", { planKey });
  return { status: 200, body: { ok: true, message: "acknowledged" } };
});
