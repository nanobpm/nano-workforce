// nano-workforce — the app-side engine-reset reconciliation surface (issue #622).
//
// When the Nano engine is reset, restored, or rolled to an incarnation whose key generator has
// rewound (Magikcraft/nano-bpm#1065), `app.db` keeps projecting ENGINE-BACKED inflight work that no
// longer exists on the engine: open user tasks pointing at dead instances, active runs keyed on a
// `process_key` the fresh engine has re-minted for something unrelated (the release-train run
// recorded `process_key=41`; the fresh engine re-minted 41 for an unrelated probe). Without a
// supported way to converge, the app silently trusts stale projections — orphaned human gates and
// key-collision identity confusion.
//
// `reconcile` is the first-class remedy. It runs ON STARTUP (main.ts) and ON DEMAND (the
// `reconcileEngineState` operator command), scoped NARROWLY to claimed inflight work:
//
//   • Detection — engine INCARNATION EPOCH (preferred over fragile per-key 404 probing). The engine
//     stamps a monotonic incarnation id at boot and exposes it on `/v2/topology`; the app persists
//     the last-seen value (`engine_incarnation`). An epoch REGRESSION (observed < recorded) — the
//     #1065 rewind signature — or its absence where one was recorded means "engine was reset/rewound
//     → reconcile", ONE cheap check instead of N per-instance probes.
//   • Convergence — for every NON-terminal, engine-backed app row (a nano.app.json instanceTracking
//     binding whose `statusField` is still in its `activeStatuses` set and whose `keyField` is
//     populated), drive the row to the defined `orphaned` terminal WITH PROVENANCE
//     (`reconcile_provenance`: the reason, the observed engine epoch, and the reconcile run id) —
//     instead of trusting a stale projection or silently dropping data.
//   • Guardrails — TERMINAL rows (done/failed/merged/abandoned/…) and append-only / non-engine-backed
//     surfaces (presence, audit, provenance) are NEVER mutated: reconcile only touches rows whose
//     status is in a binding's `activeStatuses`. Every pass is recorded in `reconcile_runs`.
//   • Idempotent — a second pass with a matching epoch is a no-op (nothing regressed, and every
//     already-orphaned row has left its `activeStatuses`, so it is not re-scanned). An UNREACHABLE
//     engine is a no-op too: reconcile NEVER orphans when it could not confirm a reset (a 401/5xx or
//     a network error yields `reachable:false`, not a false "engine missing").
//
// The provenance is app-owned (not urban's `_urban_write_provenance`, which is a domain-free
// insert-join sidecar written only inside a job): reconcile runs at boot / over HTTP, outside any
// job, and needs to record the REASON + epoch + run id — which the app-owned `reconcile_provenance`
// table carries, and the existing `app.db` backup convention makes the whole mutation reversible.

import type { DataLayer, GatewayDataSource as DataSource } from "@nanobpm/urban";
import type { TopologyProbe } from "./enginePreflight.ts";
import { activeStatusesFor, baseStatusFieldFor, engineBackedBindings, keyFieldFor } from "./instanceTracking.ts";

/** The defined terminal state a reset-orphaned engine-backed row is driven to. Deliberately DISTINCT
 *  from a binding's natural terminal (`abandoned`/`failed`/…) so an operator can tell a row that was
 *  orphaned by an engine reset apart from one that drained normally. Not in any binding's
 *  `activeStatuses`, so an orphaned row is never re-scanned (idempotency) nor re-polled by the urban
 *  instance-tracking reconciler. */
export const ORPHANED_STATUS = "orphaned";

/** The provenance reason stamped on every orphaned transition: the engine was reset/rewound and the
 *  recorded incarnation epoch regressed (the #1065 signature). */
export const RECONCILE_ORPHAN_REASON = "engine-reset/epoch-regression";

/** The single-row epoch ledger + its append-only run/provenance sidecars (migration 092). */
const INCARNATION_TABLE = "engine_incarnation";
const RUNS_TABLE = "reconcile_runs";
const PROVENANCE_TABLE = "reconcile_provenance";
/** The conventional last-touched timestamp column stamped on every status transition; orphaning
 *  refreshes it too, but only on the tables that actually declare it (introspected per binding). */
const UPDATED_AT_COLUMN = "updated_at";

/** What a `/v2/topology` epoch probe observed. `reachable:false` means the engine could not be
 *  confirmed (network error, or a non-2xx like 401/5xx) — reconcile then does NOTHING, so a
 *  transient outage can never be mistaken for a reset and orphan live work. `reachable:true` with a
 *  null `epoch` means the engine answered but exposes no incarnation id (e.g. a stock Camunda 8
 *  gateway, or before Magikcraft/nano-bpm#1068 ships). That null is a no-op ONLY when no epoch was
 *  ever recorded; if a concrete epoch WAS recorded, a now-null observation reads as a regression
 *  ("the epoch disappeared" — the reset signature), so reconcile orphans inflight work. See the
 *  decision table on {@link reconcileEngineBackedWork}. */
export interface EngineEpochObservation {
  reachable: boolean;
  epoch: number | null;
}

/** Why a reconcile pass acted (or did not). */
export type ReconcileReason = "epoch-regression" | "seed-epoch" | "no-op" | "engine-unreachable";

/** One orphaned engine-backed row. */
export interface OrphanedRow {
  table: string;
  pk: string;
  key: string | null;
  fromStatus: string;
}

/** The outcome of one reconcile pass — the same shape the run row records and the operator command
 *  returns. */
export interface ReconcileResult {
  runId: string;
  reason: ReconcileReason;
  observedEpoch: number | null;
  recordedEpoch: number | null;
  orphanedCount: number;
  orphaned: OrphanedRow[];
}

export interface ReconcileLog {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface ReconcileOptions {
  /** Injectable clock (defaults to `Date`), so tests are deterministic. */
  now?: () => Date;
  /** Injectable run id (defaults to a random UUID). */
  runId?: string;
  /** The data source name to reconcile (defaults to the DataLayer's default source). */
  sourceName?: string;
  log?: ReconcileLog;
}

/** Read the incarnation epoch out of a `/v2/topology` body — `nano.incarnation` (or its `epoch`
 *  alias), coerced from a number or a numeric string. Any other shape (absent, non-numeric) yields
 *  null: "the engine exposes no epoch". A null is a no-op ONLY when no epoch was previously recorded;
 *  when one WAS recorded, reconcile reads a now-null observation as a regression ("epoch disappeared"),
 *  not a no-op — see the decision table on {@link reconcileEngineBackedWork}. */
export function parseEngineEpoch(body: TopologyProbe | null | undefined): number | null {
  const raw = body?.nano?.incarnation ?? body?.nano?.epoch;
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Probe `/v2/topology` for the engine incarnation epoch. Never throws: a network error or a non-2xx
 *  yields `reachable:false` (reconcile then does nothing), so an outage can never orphan live work. */
export async function probeEngineEpoch(
  restAddress: string,
  opts: { token?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<EngineEpochObservation> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${restAddress.replace(/\/+$/, "")}/topology`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  try {
    const res = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 3000),
    });
    if (!res.ok) return { reachable: false, epoch: null };
    const body: TopologyProbe = await res.json();
    return { reachable: true, epoch: parseEngineEpoch(body) };
  } catch {
    return { reachable: false, epoch: null };
  }
}

/** Double-quote a SQL identifier (table/column) so a manifest-declared name is safe to interpolate. */
function q(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

/** The schema of `table` we need to orphan a row: its primary-key column (the first `pk`-flagged
 *  column from `PRAGMA table_info`, or `rowid` when the table declares none — so provenance always
 *  records a stable row identity) and whether it carries an `updated_at` column to stamp. */
async function tableShape(src: DataSource, table: string): Promise<{ pkCol: string; hasUpdatedAt: boolean }> {
  const cols = await src.query<{ name: string; pk: number }>(`PRAGMA table_info(${q(table)})`);
  const pk = cols.find((c) => Number(c.pk) > 0);
  return { pkCol: pk?.name ?? "rowid", hasUpdatedAt: cols.some((c) => c.name === UPDATED_AT_COLUMN) };
}

/** The recorded last-seen epoch, or null when none was ever recorded (no row, or a null epoch). */
async function readRecordedEpoch(src: DataSource): Promise<number | null> {
  const rows = await src.query<{ epoch: number | null }>(
    `SELECT epoch FROM ${INCARNATION_TABLE} WHERE id = 1`,
  );
  const epoch = rows.length ? rows[0].epoch : null;
  return epoch == null ? null : Number(epoch);
}

/** Persist (seed or advance) the last-seen epoch. Only ever called with a concrete number, so a
 *  recorded epoch always means "an epoch was actually observed". */
async function persistEpoch(src: DataSource, epoch: number, at: string): Promise<void> {
  await src.exec(
    `INSERT INTO ${INCARNATION_TABLE} (id, epoch, observed_at) VALUES (1, ?, ?) ` +
      `ON CONFLICT(id) DO UPDATE SET epoch = excluded.epoch, observed_at = excluded.observed_at`,
    [epoch, at],
  );
}

/** Orphan every NON-terminal, engine-backed row across all instanceTracking bindings, recording one
 *  `reconcile_provenance` row per transition. Runs inside the caller's transaction. */
async function orphanEngineBackedRows(
  src: DataSource,
  runId: string,
  observedEpoch: number | null,
  at: string,
): Promise<OrphanedRow[]> {
  const orphaned: OrphanedRow[] = [];
  for (const binding of engineBackedBindings()) {
    const table = binding.table;
    // A binding with no active-status selector cannot classify "in-flight" — skip it rather than
    // guess (activeStatusesFor would throw; we tolerate a selector-less binding).
    if (!binding.activeStatuses?.length) continue;
    const active = activeStatusesFor(table);
    const statusField = baseStatusFieldFor(table);
    const keyField = keyFieldFor(table);
    const { pkCol, hasUpdatedAt } = await tableShape(src, table);
    const placeholders = active.map(() => "?").join(", ");
    const rows = await src.query<{ __pk: unknown; __key: unknown; __status: unknown }>(
      `SELECT ${q(pkCol)} AS __pk, ${q(keyField)} AS __key, ${q(statusField)} AS __status ` +
        `FROM ${q(table)} WHERE ${q(statusField)} IN (${placeholders}) AND ${q(keyField)} IS NOT NULL`,
      [...active],
    );
    for (const row of rows) {
      const pk = String(row.__pk);
      const key = row.__key == null ? null : String(row.__key);
      const fromStatus = String(row.__status);
      // GUARDED update: re-assert the exact status we read AND a populated key, so a writer that
      // flipped the row to a newer terminal status (or cleared its key) between the SELECT above and
      // this UPDATE wins the race — we never clobber that terminal history back to `orphaned`. Only a
      // row we actually transitioned (`res.changed > 0`) gets provenance and is counted. We also stamp
      // `updated_at` (when the table has one) so the transition to `orphaned` refreshes the row's
      // timestamp the same way every other status transition in the codebase does — leaving it stale
      // would misrepresent the orphaning moment to the UI/audits.
      const res = await src.exec(
        `UPDATE ${q(table)} SET ${q(statusField)} = ?` +
          (hasUpdatedAt ? `, ${q(UPDATED_AT_COLUMN)} = ?` : "") +
          ` WHERE ${q(pkCol)} = ? AND ${q(statusField)} = ? AND ${q(keyField)} IS NOT NULL`,
        hasUpdatedAt
          ? [ORPHANED_STATUS, at, row.__pk, fromStatus]
          : [ORPHANED_STATUS, row.__pk, fromStatus],
      );
      if (res.changed <= 0) continue;
      await src.exec(
        `INSERT INTO ${PROVENANCE_TABLE} ` +
          `(run_id, source_table, pk_value, key_value, from_status, to_status, reason, observed_epoch, at) ` +
          `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [runId, table, pk, key, fromStatus, ORPHANED_STATUS, RECONCILE_ORPHAN_REASON, observedEpoch, at],
      );
      orphaned.push({ table, pk, key, fromStatus });
    }
  }
  return orphaned;
}

/**
 * Reconcile the app's engine-backed projections against one epoch observation. Pure of I/O beyond the
 * data layer (the topology probe is {@link probeEngineEpoch}, injected as `observation`), so the
 * red/green test drives it with a seeded row + a regressed epoch directly.
 *
 * Decision table (engine reachable):
 *   • recorded != null AND (observed == null OR observed < recorded)  → REGRESSION: orphan inflight.
 *   • recorded == null AND observed != null                          → SEED: first epoch learned.
 *   • otherwise                                                       → NO-OP (incl. a matching epoch).
 * The epoch is persisted whenever a concrete one was observed (seed, advance, or the fresh
 * post-rewind incarnation), so the very next pass with that same epoch is a pure no-op.
 */
export async function reconcileEngineBackedWork(
  data: DataLayer,
  observation: EngineEpochObservation,
  opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const src = data.open(opts.sourceName);
  const at = (opts.now?.() ?? new Date()).toISOString();
  const runId = opts.runId ?? crypto.randomUUID();

  // An unreachable engine is a hard no-op: we could not confirm a reset, so we NEVER orphan.
  if (!observation.reachable) {
    const recorded = await readRecordedEpoch(src);
    await recordRun(src, { runId, at, observedEpoch: null, recordedEpoch: recorded, reason: "engine-unreachable", orphanedCount: 0 });
    opts.log?.warn("reconcile: engine unreachable — skipped (no rows orphaned; live work left intact).");
    return { runId, reason: "engine-unreachable", observedEpoch: null, recordedEpoch: recorded, orphanedCount: 0, orphaned: [] };
  }

  const observedEpoch = observation.epoch;
  const recordedEpoch = await readRecordedEpoch(src);
  const regression = recordedEpoch != null && (observedEpoch == null || observedEpoch < recordedEpoch);

  const result = await src.tx(async (t) => {
    let orphaned: OrphanedRow[] = [];
    let reason: ReconcileReason;
    if (regression) {
      orphaned = await orphanEngineBackedRows(t, runId, observedEpoch, at);
      reason = "epoch-regression";
    } else if (recordedEpoch == null && observedEpoch != null) {
      reason = "seed-epoch";
    } else {
      reason = "no-op";
    }
    if (observedEpoch != null) await persistEpoch(t, observedEpoch, at);
    await recordRun(t, { runId, at, observedEpoch, recordedEpoch, reason, orphanedCount: orphaned.length });
    return { reason, orphaned };
  });

  if (result.reason === "epoch-regression") {
    opts.log?.warn(
      `reconcile: engine epoch regressed ${recordedEpoch} → ${observedEpoch} (reset/rewind) — ` +
        `orphaned ${result.orphaned.length} inflight row(s) [run ${runId}].`,
    );
  } else if (result.reason === "seed-epoch") {
    opts.log?.info(`reconcile: recorded engine epoch ${observedEpoch} (first observation) [run ${runId}].`);
  } else {
    opts.log?.info(`reconcile: engine epoch ${observedEpoch ?? "n/a"} unchanged — no-op [run ${runId}].`);
  }

  return { runId, reason: result.reason, observedEpoch, recordedEpoch, orphanedCount: result.orphaned.length, orphaned: result.orphaned };
}

async function recordRun(
  src: DataSource,
  run: { runId: string; at: string; observedEpoch: number | null; recordedEpoch: number | null; reason: ReconcileReason; orphanedCount: number },
): Promise<void> {
  await src.exec(
    `INSERT INTO ${RUNS_TABLE} (run_id, started_at, observed_epoch, recorded_epoch, reason, orphaned_count) ` +
      `VALUES (?, ?, ?, ?, ?, ?)`,
    [run.runId, run.at, run.observedEpoch, run.recordedEpoch, run.reason, run.orphanedCount],
  );
}

/** Probe the engine's incarnation epoch, then reconcile — the wiring both startup (main.ts) and the
 *  `reconcileEngineState` operator command share, so the two paths can never diverge. */
export async function runEngineReconcile(
  data: DataLayer,
  engineRest: { restAddress: string; token?: string },
  opts: ReconcileOptions & { fetchImpl?: typeof fetch } = {},
): Promise<ReconcileResult> {
  const observation = await probeEngineEpoch(engineRest.restAddress, {
    token: engineRest.token,
    fetchImpl: opts.fetchImpl,
  });
  return reconcileEngineBackedWork(data, observation, opts);
}
