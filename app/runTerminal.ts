// app/runTerminal.ts — THE canonical mapping of a run's terminal lifecycle event to a terminal status,
// shared by every tracked run kind (issue #994).
//
// THE DEFECT. Each `instanceTracking` binding owned its own `onTerminated` choice: a cancelled FEATURE
// run folded to `abandoned`, a cancelled DELIVERY GRAPH folded to `failed`. The same event — an
// operator cancel through `/actions/cancel` — read as a crash on one surface and a deliberate stop on
// another, and neither could tell a deliberate cancel apart from a genuine failure.
//
// THE FIX — one source, derived everywhere:
//   - {@link RUN_TERMINAL_STATUS} maps each lifecycle event to ONE status for every run kind. An engine
//     TERMINATED that nwf did not initiate is `abandoned` (neutral — never a failure); an operator
//     cancel through the app's cancel door is `cancelled` (neutral, with actor/reason/time recorded in
//     `run_cancellations`); only a genuine failure (an incident / a failed dispatch) is `failed`.
//   - Every RUN binding's `onTerminated` in nano.app.json MUST equal `RUN_TERMINAL_STATUS.outOfBandTerminate`
//     (guarded by app/runTerminal.test.ts — adding a run kind with a divergent mapping fails the test).
//     The two BOOKKEEPING bindings (`plan_conformance`, `delivery_units`) are not runs and keep their own
//     vocabulary; they are listed explicitly in {@link BOOKKEEPING_TRACKED_TABLES} so a NEW binding must
//     be classified (run or bookkeeping) before the guard passes.
//   - `cancelled` is DERIVED on read: the terminated edge (`abandoned`) folded with a recorded operator
//     cancellation for that process key ({@link effectiveTerminalStatus}, and its SQL twin in the
//     read-model declarations). The cancel door writes the cancellation via {@link recordRunCancellation}
//     — the ONE writer.

import type { DataLayer } from "@nanobpm/urban";

/** The run lifecycle events that end a run. */
export type RunLifecycleEvent = "operatorCancel" | "outOfBandTerminate" | "incidentFailure";

/** THE canonical lifecycle-event → terminal-status mapping, identical for every tracked run kind. */
export const RUN_TERMINAL_STATUS = {
  /** Ended through nwf's cancel door (`/actions/cancel`, `/actions/cancel-pr`). Neutral. */
  operatorCancel: "cancelled",
  /** Terminated in the engine by something other than nwf's cancel door. Neutral — NOT a failure. */
  outOfBandTerminate: "abandoned",
  /** A genuine failure (an incident / a dispatch that could not start). */
  incidentFailure: "failed",
} as const satisfies Record<RunLifecycleEvent, string>;

/** The `instanceTracking` tables that track a RUN (feature, convergence/merge loop, delivery graph,
 * plan/epic). Each MUST map `onTerminated` to {@link RUN_TERMINAL_STATUS}.outOfBandTerminate. */
export const RUN_TRACKED_TABLES = ["pull_requests", "plans", "feature_runs", "delivery_graph_runs"] as const;

/** The `instanceTracking` tables that are bookkeeping over a run, not a run themselves: their
 * terminated edge settles a sub-record (`reviewed` / `settled`), not a run outcome. */
export const BOOKKEEPING_TRACKED_TABLES = ["plan_conformance", "delivery_units"] as const;

/** The table holding operator-cancel provenance, keyed by engine process-instance key. */
export const RUN_CANCELLATIONS_TABLE = "run_cancellations";

export interface RunCancellation {
  process_key: string;
  run_table: string | null;
  cancelled_by: string;
  cancel_reason: string | null;
  cancelled_at: string;
  /** 1 once the engine confirmed the cancel this row names; 0 while it is a provisional attempt.
   * Only a COMMITTED row may promote a terminated edge to `cancelled`. */
  committed: number;
}

/** The effective terminal status of a run: the tracking VIEW's terminal-folded `derived_status`, with an
 * out-of-band-terminate edge promoted to `cancelled` when the operator cancel door recorded it. The TS
 * twin of the read-model SQL (`cancelledStatusExpr` users) — keep them on this one rule. `committed`
 * is the cancellation row's committed flag: a row the engine never confirmed (a provisional attempt)
 * must NOT promote the edge (PR #996 review). */
export function effectiveTerminalStatus(
  derivedStatus: string,
  cancelledAt: string | null | undefined,
  committed = true,
): string {
  if (derivedStatus === RUN_TERMINAL_STATUS.outOfBandTerminate && cancelledAt && committed) {
    return RUN_TERMINAL_STATUS.operatorCancel;
  }
  return derivedStatus;
}

/** Record an operator cancel of `processKey` — the ONE writer of cancellation provenance, called by
 * every cancel door BEFORE the engine cancel so a crash in between still leaves the record (an
 * un-terminated instance never reads `cancelled`: the fold requires the terminated edge). Idempotent:
 * a re-cancel keeps the first record.
 *
 * The row is written UNCOMMITTED (`committed: 0`); the door flips it with
 * {@link commitRunCancellation} once the engine confirms the termination. Only a committed row may
 * promote a terminated edge to `cancelled`, so a cancel over an ALREADY-terminated run can never
 * attribute that earlier termination to the retrying caller (PR #996 review): the retry's row stays
 * uncommitted and reads as what it is — an out-of-band `abandoned`.
 *
 * Returns whether THIS call inserted the row: the cancel door is transactional about its provisional
 * record — when the engine REFUSES the cancel it deletes the row, but only a row it inserted itself
 * (a refused retry must never delete another request's record). */
export async function recordRunCancellation(
  data: DataLayer,
  input: { processKey: string; runTable?: string | null; cancelledBy: string; reason?: string | null; at?: string },
): Promise<boolean> {
  const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : null;
  const table = data.table<RunCancellation>(RUN_CANCELLATIONS_TABLE, "process_key");
  if (await table.get(input.processKey)) return false;
  await table.insert({
    process_key: input.processKey,
    run_table: input.runTable ?? null,
    cancelled_by: input.cancelledBy,
    cancel_reason: reason,
    cancelled_at: input.at ?? new Date().toISOString(),
    committed: 0,
  });
  return true;
}

/** Mark the cancellation record COMMITTED — the engine confirmed the termination it names. Only a
 * committed row promotes the run's terminated edge (`abandoned`) to `cancelled`
 * ({@link effectiveTerminalStatus} and its SQL twin). Best-effort, exactly like the write it
 * finalises. */
export async function commitRunCancellation(data: DataLayer, processKey: string): Promise<void> {
  await data.table<RunCancellation>(RUN_CANCELLATIONS_TABLE, "process_key").update(processKey, { committed: 1 });
}

/** Delete a PROVISIONAL (uncommitted) cancellation record this call inserted
 * ({@link recordRunCancellation}) when the engine refused the cancel it preceded. The caller passes
 * the `inserted` flag its record call returned, so a refused request only ever removes its OWN
 * provisional write — never another request's row, committed or not (PR #996 review: a failed
 * overlapping request must not delete the successful request's provenance). Best-effort, exactly
 * like the write it undoes. */
export async function removeRunCancellation(data: DataLayer, processKey: string): Promise<void> {
  await data.table<RunCancellation>(RUN_CANCELLATIONS_TABLE, "process_key").delete(processKey);
}

/** Read the recorded operator cancellation for a process key, if any. */
export async function readRunCancellation(data: DataLayer, processKey: string): Promise<RunCancellation | undefined> {
  const row = await data.table<RunCancellation>(RUN_CANCELLATIONS_TABLE, "process_key").get(processKey);
  return row ?? undefined;
}
