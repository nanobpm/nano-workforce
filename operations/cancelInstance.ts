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

import type { AppApi } from "@nanobpm/urban";
import { cancelInstanceReconciling } from "@nanobpm/urban";
import { engineBackedBindings, resolveTrackedInstance } from "../app/instanceTracking.ts";
import { commitRunCancellation, recordRunCancellation, removeRunCancellation } from "../app/runTerminal.ts";
import { closeCancelledRunEscalations, recordOperatorCancelProvenance } from "../app/service.ts";
import { envVar } from "../app/version.ts";
import type { CancelInstanceResponse } from "../nano-generated/api-io.d.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

/** Serialize the whole record → engine-cancel → commit/rollback sequence PER PROCESS KEY (PR #996
 * review): two overlapping cancel requests for the same run used to interleave their provisional
 * record write / engine cancel / rollback so a failed request could delete a successful request's
 * provenance. A process-wide keyed mutex makes the sequence atomic per run without any cross-process
 * locking (different keys still cancel concurrently). Exported for the race regression test. */
export const cancelKeyLocks = new Map<string, Promise<void>>();

/** Test-only: drop every queued/acquired per-key lock so each test starts with a clean mutex map. */
export function resetCancelKeyLocks(): void {
  cancelKeyLocks.clear();
}

async function withCancelKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = cancelKeyLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Store and compare the SAME queued promise: comparing against `mine` (never the stored value) left
  // every key in the map forever (unbounded growth; PR #996 review). A newer waiter replaces the entry,
  // so the identity check also preserves its chain.
  const queued = prior.then(() => mine);
  cancelKeyLocks.set(key, queued);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    if (cancelKeyLocks.get(key) === queued) cancelKeyLocks.delete(key);
  }
}

/** Engine truth for "is this instance still running": true = ACTIVE, false = positively not running
 * (TERMINATED / COMPLETED / gone), null = the probe failed (caller falls back to its record snapshot). */
async function readEngineLiveness(app: AppApi, processInstanceKey: string): Promise<boolean | null> {
  try {
    const [snapshot] = await app.engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] });
    return snapshot ? snapshot.state === "ACTIVE" : false;
  } catch (err) {
    app.log.warn("cancelInstance: could not probe engine liveness before cancel", { processInstanceKey, error: String(err) });
    return null;
  }
}

export default defineOperation("cancelInstance", async ({ req, body }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("cancelInstance rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  return cancelTrackedRun(app, body, "/actions/cancel");
});

/** The ONE record-consistent cancel implementation shared by every cancel door (this guarded API/MCP
 * door and the unguarded page door `/actions/cancel-pr`, operations/cancelPrRun.ts), so both stamp
 * termination provenance (issue #943, PR #944 review) and neither can drift. Auth stays per door. */
export async function cancelTrackedRun(
  app: AppApi,
  body: unknown,
  door: string,
): Promise<{ status: number; body: CancelInstanceResponse }> {
  if (!app.data) {
    app.log.warn("cancelInstance: no data source configured — cannot reconcile the record");
    return { status: 503, body: { error: "no data source configured" } };
  }

  // Require a STRING key. Engine instance keys are 64-bit and can exceed JS's safe-integer range,
  // so a numeric JSON value would already have lost precision before it reached us — accepting it
  // (and coercing it back to a string) would silently cancel the wrong instance and also contradicts
  // the OpenAPI `string` contract. Reject a non-string with a 400 rather than coerce.
  const raw = body && typeof body === "object" && "processInstanceKey" in body ? body.processInstanceKey : undefined;
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
  let resolvedTable: string | null = null;
  // Whether the resolved record was still ACTIVE (non-terminal) when this request looked — the
  // signal that distinguishes a FRESH termination (this cancel ended a live run → commit its
  // provenance) from a retry over an already-terminal run (never re-attribute; PR #996 review).
  let resolvedRecordActive = false;
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
          // No tracked record owns this key, so from the door's aggregates the run is `gone`. Carry a
          // `state` so the body is a full CancelInstanceResult (uniform shape for clients/projection).
          state: "gone",
          reconciled: 0,
          error: "no tracked record for processInstanceKey",
        },
      };
    }
    resolvedTable = record.table;
    resolvedRecordActive = record.active;
  }

  // Operator-cancel provenance (issue #994): record WHO/WHEN/WHY BEFORE the engine cancel, so a crash
  // between the two still leaves it. The row is written UNCOMMITTED and only ever reads as `cancelled`
  // once (a) the instance is actually TERMINATED and (b) the row is COMMITTED (the read models fold a
  // committed row over the canonical terminated edge, app/runTerminal.ts) — so:
  //   - a cancel the engine REFUSES never mislabels a live run (its provisional row is deleted on the
  //     !ok path below, and would inert-read `abandoned` even if the delete failed);
  //   - a cancel over an ALREADY-terminated run (a retry) never attributes that earlier termination to
  //     the retrying caller: its row is only committed when the run was still LIVE when this request
  //     resolved it (PR #996 review).
  // Best-effort — provenance never blocks the cancel. The record is TRANSACTIONAL with the cancel it
  // names: `inserted` marks whether THIS call wrote the row, so the !ok path deletes exactly its own
  // provisional write.
  //
  // The whole record → engine-cancel → commit/rollback sequence runs under a per-key mutex
  // (withCancelKeyLock): without it, two overlapping requests interleave so that a refused request's
  // rollback can delete the row a concurrent request just committed (PR #996 review).
  return withCancelKeyLock(processInstanceKey, async () => {
    let cancellationRecorded = false;
    if (canResolveRecord) {
      try {
        cancellationRecorded = await recordRunCancellation(app.data, {
          processKey: processInstanceKey,
          runTable: resolvedTable,
          cancelledBy: optionalText(body, "actor") ?? "operator",
          reason: optionalText(body, "reason") ?? `operator cancel (${door})`,
        });
      } catch (err) {
        app.log.warn("cancelInstance: could not record the run cancellation", { processInstanceKey, error: String(err) });
      }
    }

    // Engine-truth liveness BEFORE the cancel (PR #996 review): the tracking snapshot can lag an
    // out-of-band terminate between polls, and the shared primitive reports a throw + TERMINATED
    // readback as idempotent success, so neither alone proves THIS call ended the run. Only an
    // instance the engine itself reports ACTIVE right before our cancel is a fresh termination.
    const engineLiveBefore = canResolveRecord ? await readEngineLiveness(app, processInstanceKey) : null;

    const result = await cancelInstanceReconciling(
      app,
      [...engineBackedBindings()],
      processInstanceKey,
    );

    // A !ok result means the engine did NOT stop the instance (the cancel was not committed); the run
    // may still be live, so surface 502 — the same non-committed-cancel signal the built-in page
    // action returns. Report it before we assert anything about the record (nothing was reconciled).
    // Delete THIS call's provisional provenance row first: left behind, it would linger as an
    // uncommitted attempt. Only a row THIS call inserted is removed — a refused retry must never
    // delete another request's record, committed or not (PR #996 review). Best-effort, exactly like
    // the write it undoes: a failed delete only leaves an inert uncommitted row, it never blocks the
    // truthful 502.
    if (!result.ok) {
      if (cancellationRecorded) {
        try {
          await removeRunCancellation(app.data, processInstanceKey);
        } catch (err) {
          app.log.warn("cancelInstance: could not delete the provisional run cancellation", {
            processInstanceKey,
            error: String(err),
          });
        }
      }
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

    // The engine confirmed termination. COMMIT the provenance row so the read models fold this run's
    // terminated edge to `cancelled` with this actor/time/reason — but ONLY when this cancel is a
    // FRESH termination. A cancel over an instance that was already TERMINATED (a retry over an
    // out-of-band terminate, or over an earlier committed cancel) must not re-attribute that earlier
    // ending to this caller: the shared primitive treats a throw + TERMINATED readback as idempotent
    // success, so `result.ok` alone cannot tell the two apart. The distinguishing signal the door owns
    // is the record state it resolved BEFORE the cancel: a run whose tracked record was ALREADY
    // terminal (its derived_status had left activeStatuses) was not ended by this call. Commit only
    // when the record was still ACTIVE at resolve time (or unresolvable — trust the engine's
    // committed 204 there); a retry over an already-terminal record leaves its row uncommitted and
    // the run keeps its truthful out-of-band `abandoned` status.
    // Fail CLOSED on both ownership and liveness (PR #996 review): commit only when THIS request owns
    // the provisional row (`cancellationRecorded` — a failed re-own leaves a stale caller's row that
    // must never be committed under this request) AND the engine POSITIVELY reported ACTIVE before the
    // cancel (an unreadable probe falls back to nothing: a lagging tracking snapshot alone cannot
    // distinguish a fresh termination from an out-of-band one).
    let provenanceUnfinalized = false;
    if (canResolveRecord && cancellationRecorded && resolvedRecordActive && engineLiveBefore === true) {
      // The engine already terminated the run, so after this point no retry can prove freshness again:
      // finalisation must be recovered HERE, in the request that owns the row. Retry the commit a
      // bounded number of times (the row keeps this request's original actor/time/reason throughout);
      // if it still fails, surface a 502 rather than a silent 200 over a run that reads `abandoned`.
      provenanceUnfinalized = !(await commitWithRetry(app, processInstanceKey));
    }

    // The engine confirmed termination. Report a TRUTHFUL `reconciled` off the RECORD's derived terminal
    // edge, not the primitive's projection-write delta: an already-TERMINATED instance re-fed on this
    // pass writes nothing new (`result.reconciled === 0`) yet its record IS (now) terminal, so the
    // delta lies. Re-read the resolved record and count it reconciled only when its ADR-0065
    // `derived_status` has LEFT its `activeStatuses` (become terminal → resubmittable). When we cannot
    // read the record (no default source), trust the primitive's own count.
    // Termination provenance (issue #943): a deliberate operator cancel of a PR loop is NOT an orphan —
    // stamp the reason (as soon as the ENGINE confirms termination, before
    // the record re-read — a 502 on an unreconciled record must not lose it; PR #944 review) on the owning PR row so `/status` does not flag it `orphaned`. Best-effort.
    if (canResolveRecord) {
      try {
        await recordOperatorCancelProvenance(app.data, processInstanceKey, door);
      } catch (err) {
        app.log.warn("cancelInstance: could not record termination reason", { processInstanceKey, error: String(err) });
      }
      // A cancelled run can never consume an answer: retire its open escalations so they drop out of the
      // inbox / `escalations list` immediately instead of lingering until an `ack pr` (issue #988).
      try {
        await closeCancelledRunEscalations(app.data, processInstanceKey);
      } catch (err) {
        app.log.warn("cancelInstance: could not close the run's open escalations", { processInstanceKey, error: String(err) });
      }
    }

    let reconciled = result.reconciled;
    let recordReconciled = true;
    if (canResolveRecord) {
      const after = await resolveTrackedInstance(app.data, processInstanceKey);
      recordReconciled = !!after && !after.active;
      reconciled = recordReconciled ? 1 : 0;
    }

    if (provenanceUnfinalized) {
      return {
        status: 502,
        body: {
          ok: false,
          processInstanceKey: result.processInstanceKey,
          state: result.state,
          reconciled,
          error: "instance terminated but cancellation provenance could not be finalized",
        },
      };
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
}


/** Attempts made to finalize (commit) a confirmed cancellation's provenance before giving up. */
export const COMMIT_ATTEMPTS = 3;

/** Commit the provisional cancellation row, retrying transient failures. True once committed. */
async function commitWithRetry(app: AppApi, processInstanceKey: string): Promise<boolean> {
  for (let attempt = 1; attempt <= COMMIT_ATTEMPTS; attempt++) {
    try {
      await commitRunCancellation(app.data, processInstanceKey);
      return true;
    } catch (err) {
      app.log.warn("cancelInstance: could not commit the run cancellation", {
        processInstanceKey,
        attempt,
        error: String(err),
      });
    }
  }
  return false;
}

/** A trimmed, non-blank optional string field off the request body, else undefined. */
function optionalText(body: unknown, field: "actor" | "reason"): string | undefined {
  if (!body || typeof body !== "object" || !(field in body)) return undefined;
  const v: unknown = Reflect.get(body, field);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
