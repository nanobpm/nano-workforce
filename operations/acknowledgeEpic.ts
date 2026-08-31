// POST /app/api/actions/acknowledge-epic → operationId `acknowledgeEpic` (issue #298; generalised by
// #654). The nwf UI's "Dismiss" affordance for a RESOLVED epic: an operator dismisses a `done` epic
// whose fan-out has finished (all slice PRs reached a terminal state — whether all merged/landed or
// resolved-not-landed), OR a `failed`/`abandoned` epic, directly from the Epic / Overview pages so it
// drops out of the Active epic list into History. A resolved epic is NOT parked at a user task, so this
// op completes no user task and touches no engine/ledger: it simply stamps `acknowledged_at` on the
// `plans` row. The epic twin of `acknowledgeDone` / `acknowledgePr` / `acknowledgeDeliveryGraph`.
//
// This op is now a one-liner over the shared `acknowledgeVia` helper (issue #654), which gates on the
// `plan_read_model` VIEW's derived `ack_open` — the SAME oracle the Dismiss button reads via
// `showWhenField`. The epic's `ack_open` additionally excludes a still-`converging` done epic (the
// VIEW folds delivery from the slice PRs), so a converging epic is correctly non-dismissable (409) and
// stays Active. This retires the op's bespoke `epicIsAcknowledgeable(plan.status, delivery)` guard: the
// affordance and the guard now read one oracle and cannot drift, and a `done` epic frozen non-terminal
// on base `status` while the read model folds it terminal no longer trips the guard.

import { acknowledgeVia } from "../app/acknowledge.ts";
import { planReadModel } from "../app/planReadModel.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export default defineOperation("acknowledgeEpic", async ({ body }, app) => {
  if (!body || typeof body !== "object") {
    app.log.warn("acknowledge-epic rejected: missing request body");
    return { status: 400, body: { ok: false, error: "plan_key is required" } };
  }

  const planKey = str(body.plan_key);
  if (!planKey) return { status: 400, body: { ok: false, error: "plan_key is required" } };

  return acknowledgeVia(
    app,
    {
      view: planReadModel.decl.name,
      baseTable: "plans",
      keyColumn: "plan_key",
      label: "epic",
      notDismissableError: "epic is not resolved",
    },
    planKey,
  );
});
