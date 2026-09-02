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
// Record-type routing + a TRUTHFUL result (issue #705). #667 shipped this door reconciling the
// pull_requests / plans aggregates, but a `processInstanceKey` belonging to a FEATURE RUN reported
// `reconciled:0` and left the `feature_runs` row inconsistent — the run stayed wedged and resubmit
// returned a green "Done". The reconcile itself is binding-agnostic (the shared primitive records the
// terminal fact into `urban_instance_state`, and EVERY binding's derived view — feature_runs included
// — folds it), so the gap was in what the door RESOLVED and REPORTED:
//   - It resolves the record type from the key across ALL engine-backed bindings
//     (`resolveTrackedInstance`) and requires a hit: a key that maps to NO tracked record is a clean
//     404 no-op, not a silent `reconciled:0` success (and we never terminate an instance we don't
//     track).
//   - `reconciled` reflects the REAL record transition — whether the resolved record's ADR-0065
//     `derived_status` has left its `activeStatuses` (become terminal) — NOT the primitive's
//     projection-write delta, which reports 0 for an ALREADY-terminated instance whose record is in
//     fact (now) terminal. So the `reconciled:0`-on-already-TERMINATED case returns a flipped record.
//   - Terminating a run whose record could NOT be reconciled is not an unqualified `ok:true`.
//
// The runtime validates the body against openapi.yaml (`processInstanceKey` required); the optional
// shared-secret guard stays HERE (the runtime does not enforce OpenAPI `security`): as a MUTATING
// door, when NANO_PR_WEBHOOK_SECRET is set callers must present it via the x-hook-secret header —
// mirroring `reconcileEngineState`/`agentCompleteEscalation`.

import { cancelInstanceReconciling } from "@nanobpm/urban";
import { engineBackedBindings, resolveTrackedInstance } from "../app/instanceTracking.ts";
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

  // Resolve which tracked aggregate (PR / plan / feature run / …) this key belongs to BEFORE we touch
  // the engine (issue #705). A key that maps to NO tracked record is a clean 404 no-op — we neither
  // cancel an instance we don't track nor report a silent `reconciled:0` success. Only meaningful with
  // a readable default source; without one (e.g. a `mount.data:false` deployment) there is no derived
  // view to resolve against, so fall through to the primitive-only path below (behaviour unchanged).
  const canResolveRecord = app.data.hasDefaultSource();
  if (canResolveRecord) {
    const record = await resolveTrackedInstance(app.data, processInstanceKey);
    if (!record) {
      app.log.warn("cancelInstance: no tracked record for processInstanceKey — no-op", {
        processInstanceKey,
      });
      return {
        status: 404,
        body: {
          ok: false,
          processInstanceKey,
          reconciled: 0,
          error: "no tracked record for processInstanceKey",
        },
      };
    }
  }

  const result = await cancelInstanceReconciling(
    app,
    [...engineBackedBindings()],
    processInstanceKey,
  );

  // A !ok result means the engine did NOT stop the instance (the cancel was not committed); the run
  // may still be live, so surface 502 — the same non-committed-cancel signal the built-in page
  // action returns. Report it before we assert anything about the record (nothing was reconciled).
  if (!result.ok) {
    app.log.warn("cancelInstance: engine did not confirm termination", {
      processInstanceKey,
      state: result.state,
      error: result.error,
    });
    return {
      status: 502,
      body: {
        ok: false,
        processInstanceKey: result.processInstanceKey,
        state: result.state,
        reconciled: 0,
        ...(result.error !== undefined ? { error: result.error } : {}),
      },
    };
  }

  // The engine confirmed termination. Report a TRUTHFUL `reconciled` off the RECORD's derived terminal
  // edge, not the primitive's projection-write delta: an already-TERMINATED instance re-fed on this
  // pass writes nothing new (`result.reconciled === 0`) yet its record IS (now) terminal, so the
  // delta lies. Re-read the resolved record and count it reconciled only when its ADR-0065
  // `derived_status` has LEFT its `activeStatuses` (become terminal → resubmittable). When we cannot
  // read the record (no default source), trust the primitive's own count.
  let reconciled = result.reconciled;
  let recordReconciled = true;
  if (canResolveRecord) {
    const after = await resolveTrackedInstance(app.data, processInstanceKey);
    recordReconciled = !!after && !after.active;
    reconciled = recordReconciled ? 1 : 0;
  }

  const responseBody = {
    ok: result.ok && recordReconciled,
    processInstanceKey: result.processInstanceKey,
    state: result.state,
    reconciled,
    ...(result.error !== undefined ? { error: result.error } : {}),
  };

  // The engine stopped the instance but the record did not settle to a terminal edge — terminating a
  // run whose record could not be reconciled is not an unqualified `ok:true` (issue #705). Surface it
  // as a 502 so the caller does not read a wedged record as "done".
  if (!recordReconciled) {
    app.log.warn("cancelInstance: instance terminated but record not reconciled", {
      processInstanceKey,
      state: result.state,
    });
    return {
      status: 502,
      body: {
        ...responseBody,
        error: responseBody.error ?? "instance terminated but tracked record was not reconciled",
      },
    };
  }

  app.log.info("cancelInstance: instance terminated", {
    processInstanceKey,
    state: result.state,
    reconciled,
  });
  return { status: 200, body: responseBody };
});
