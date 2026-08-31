// POST /app/api/actions/cancel → operationId `cancelInstance` (issue #667, epic #664).
//
// The app-owned, RECORD-CONSISTENT unstick for a wedged run. agent-guide §7 documents
// `POST /actions/cancel { processInstanceKey }` as the CORRECT way to abort a run — "go through the
// app so its record state stays consistent" — but until now the only cancel projected over MCP was
// the engine-level `urban_debug_cancel_instance`, which §7 warns against because it terminates the
// instance out from under the app and leaves the PR/plan row inconsistent. This delegate closes that
// doc/impl drift by exposing the app door as a projected MCP tool.
//
// Derivation over duplication (AGENTS.md): it does NOT re-implement the cancel-then-transition
// dance. It routes through the EXACT same primitive the UI's per-row Cancel button uses —
// urban's `cancelInstanceReconciling` (the handler wired to the built-in `/app/actions/cancel`
// page action) — so there is ONE source of truth for terminating the instance and recording the
// terminal source into the canonical instance-state projection. The PR's tracking status then
// derives to `abandoned` (ADR 0065) and the row drops out of `listActivePrs`. The `instanceTracking`
// bindings come from the app's single accessor (`engineBackedBindings`), so the set can never drift
// from the reconciler's registry.
//
// The runtime validates the body against openapi.yaml (`processInstanceKey` required); the optional
// shared-secret guard stays HERE (the runtime does not enforce OpenAPI `security`): as a MUTATING
// door, when NANO_PR_WEBHOOK_SECRET is set callers must present it via the x-hook-secret header —
// mirroring `reconcileEngineState`/`agentCompleteEscalation`.

import { cancelInstanceReconciling } from "@nanobpm/urban";
import { engineBackedBindings } from "../app/instanceTracking.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("cancelInstance", async ({ req, body }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("cancelInstance rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  if (!app.data) {
    app.log.warn("cancelInstance: no data source configured — cannot reconcile the record");
    return { status: 503, body: { error: "no data source configured" } };
  }

  // Require a STRING key. Engine instance keys are 64-bit and can exceed JS's safe-integer range,
  // so a numeric JSON value would already have lost precision before it reached us — accepting it
  // (and coercing it back to a string) would silently cancel the wrong instance and also contradicts
  // the OpenAPI `string` contract. Reject a non-string with a 400 rather than coerce.
  const raw = body && typeof body === "object" ? body.processInstanceKey : undefined;
  const processInstanceKey = typeof raw === "string" ? raw.trim() : "";
  if (!processInstanceKey) {
    return { status: 400, body: { error: "processInstanceKey is required and must be a string" } };
  }

  const result = await cancelInstanceReconciling(
    app,
    [...engineBackedBindings()],
    processInstanceKey,
  );
  const responseBody = {
    ok: result.ok,
    processInstanceKey: result.processInstanceKey,
    state: result.state,
    reconciled: result.reconciled,
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
  if (result.ok) {
    app.log.info("cancelInstance: instance terminated", {
      processInstanceKey,
      state: result.state,
      reconciled: result.reconciled,
    });
    return { status: 200, body: responseBody };
  }
  // A !ok result means the engine did NOT stop the instance (the cancel was not committed); the run
  // may still be live, so surface 502 — the same non-committed-cancel signal the built-in page
  // action returns.
  app.log.warn("cancelInstance: engine did not confirm termination", {
    processInstanceKey,
    state: result.state,
    error: result.error,
  });
  return { status: 502, body: responseBody };
});
