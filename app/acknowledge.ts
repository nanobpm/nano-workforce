// The ONE shared "operator dismiss / tick-off" acknowledge helper, gating every acknowledge op on the
// read model's derived `ack_open` (issue #654). Introduced to kill a CATEGORICAL drift: each of the
// four acknowledge/dismiss ops (`acknowledgePr` / `acknowledgeDone` / `acknowledgeDeliveryGraph` /
// `acknowledgeEpic`) used to re-derive terminality from its BASE `status` column, while the Dismiss
// affordance the UI renders reads the read model's `ack_open` (folded from the terminal-folded
// `derived_status`). When base ≠ derived — any out-of-band terminate freezes base `status` at
// `running`/`escalated`/`dispatched` while the read model folds `derived_status='abandoned'` — the
// button showed "Dismiss" but the op 409'd "not terminal" (manifested for PR, #652; latent for the
// other three).
//
// The fix: gate on the SAME `ack_open` the button consumes, so the affordance and the guard read one
// oracle and cannot drift. Each op collapses to a one-liner passing its own read-model VIEW + key
// column; this helper does the rest:
//
//   1. Look up the row in the read-model VIEW (the `..._read_model` VIEW exposing `ack_open`) by key.
//   2. 404 if the row is absent.
//   3. 409 if `ack_open !== 1` and the row is NOT already acknowledged (a live / non-dismissable row).
//   4. An already-acknowledged row (`ack_open=0` because `acknowledged_at` is set) is an idempotent
//      no-op → 200 (no double-stamp), not an error.
//   5. Stamp `acknowledged_at = now()` (+ `updated_at`) on the base RECORD table (writes never go to
//      the VIEW). The VIEW then folds the row to `list_bucket='history'` / `ack_open=0` at read time.

import type { AppApi } from "@nanobpm/urban";

/** A dismissable surface: the read-model VIEW the Dismiss affordance + this guard both read `ack_open`
 * off, the base RECORD table the `acknowledged_at` stamp lands on, the primary-key column both are
 * keyed on, and a human label for the log/error text. */
export interface AckSurface {
  /** The read-model VIEW exposing the derived `ack_open` + pass-through `acknowledged_at` — the SINGLE
   * oracle the page's `showWhenField` Dismiss button also consumes (so guard and button cannot drift). */
  readonly view: string;
  /** The base RECORD table the `acknowledged_at` stamp is written to (urban forbids writing a VIEW). */
  readonly baseTable: string;
  /** The primary-key column both the VIEW and the base table are keyed on. */
  readonly keyColumn: string;
  /** Human-readable noun for the op's log lines and 404/409 error bodies (e.g. "pull request"). */
  readonly label: string;
  /** The 409 error message for a NON-dismissable (still-live / not-terminal) row. */
  readonly notDismissableError: string;
}

/** The row shape the helper reads off the read-model VIEW. */
interface AckViewRow {
  ack_open: number | null;
  acknowledged_at: string | null;
}

/** The uniform op result the four acknowledge ops return verbatim. */
export interface AckResult {
  status: number;
  body: { ok: boolean; error?: string; message?: string };
}

/**
 * Acknowledge (operator-dismiss / tick-off) the `key` row of a dismissable {@link AckSurface}, gating
 * on the read model's derived `ack_open` — the ONE oracle the Dismiss button also reads, so the guard
 * and the affordance cannot drift (issue #654). Returns the uniform op result:
 *
 * - 404 — no such row in the read-model VIEW.
 * - 200 (idempotent no-op) — the row is already acknowledged (`acknowledged_at` set), so re-dismissing
 *   is a no-op that does NOT re-stamp.
 * - 409 — the row is not dismissable (`ack_open=0` and not acknowledged: still live / non-terminal).
 * - 200 (stamped) — `ack_open=1`: stamp `acknowledged_at = now()` on the base record table; the VIEW
 *   folds the row to History (`list_bucket='history'`, `ack_open=0`) on the next read.
 */
export async function acknowledgeVia(app: AppApi, surface: AckSurface, key: string): Promise<AckResult> {
  const view = app.data.table<AckViewRow>(surface.view, surface.keyColumn);
  const row = await view.get(key);
  if (!row) {
    app.log.warn(`acknowledge: no such ${surface.label}`, { key });
    return { status: 404, body: { ok: false, error: `no such ${surface.label}` } };
  }

  // The button and this guard consume the SAME derived `ack_open` from the SAME read-model VIEW, so
  // they cannot drift: `ack_open=1` ⇔ the row is terminal-folded AND not yet acknowledged ⇔ dismissable.
  if (Number(row.ack_open) !== 1) {
    // `ack_open=0` is EITHER an already-acknowledged terminal row OR a still-live / non-terminal one.
    // An already-acknowledged row (its `acknowledged_at` set — the whole reason `ack_open` folded to 0)
    // is an idempotent no-op → 200, NOT an error; we do not re-stamp it.
    if (row.acknowledged_at != null) {
      app.log.info(`${surface.label} already acknowledged — idempotent no-op`, { key });
      return { status: 200, body: { ok: true, message: "acknowledged" } };
    }
    app.log.warn(`acknowledge rejected: ${surface.label} is not dismissable`, { key });
    return { status: 409, body: { ok: false, error: surface.notDismissableError } };
  }

  // Stamp the dismissal on the base RECORD table (never the VIEW). `list_bucket` (→ 'history') and
  // `ack_open` (→ 0) are derived by the read-model VIEW from the now-acknowledged row, so we never
  // hand-set them here.
  const now = new Date().toISOString();
  await app.data
    .table<{ acknowledged_at: string | null; updated_at: string }>(surface.baseTable, surface.keyColumn)
    .update(key, { acknowledged_at: now, updated_at: now });

  app.log.info(`operator acknowledged ${surface.label}`, { key });
  return { status: 200, body: { ok: true, message: "acknowledged" } };
}
