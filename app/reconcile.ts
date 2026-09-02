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
// A second, complementary pass covers the "instance absent/unknown" gap (issue #630) the epoch signal
// alone cannot: an inflight run whose engine instance has VANISHED from the read model — its
// `keyField` (process_key) has NO `_urban_instance_state` row at all (engine clean-reset, cluster
// rebuild, or read-model pruning removed it), so the derived tracking edge has no `TERMINATED` row to
// match and the run freezes at its last worker-owned status, wedging Active forever with no
// reconciliation path (the observed pre-reset orphan `Magikcraft/nano-bpm#1051`, process_key 71506).
// `reconcileVanishedInstances` drives every such row — active, dispatched, its key absent from
// `_urban_instance_state`, and PAST A GRACE WINDOW (so a still-starting run not yet projected is
// spared) — to the same `orphaned` terminal, with a DISTINCT provenance reason so an operator can
// tell a vanished-instance orphan apart from an epoch-regression one. `runEngineReconcile` runs BOTH
// passes, so startup and the operator command converge both failure modes in one call.
//
// The provenance is app-owned (not urban's `_urban_write_provenance`, which is a domain-free
// insert-join sidecar written only inside a job): reconcile runs at boot / over HTTP, outside any
// job, and needs to record the REASON + epoch + run id — which the app-owned `reconcile_provenance`
// table carries, and the existing `app.db` backup convention makes the whole mutation reversible.

import type { DataLayer, GatewayDataSource as DataSource, InstanceTracking } from "@nanobpm/urban";
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

/** The provenance reason stamped when a row is orphaned because its engine instance VANISHED from the
 *  read model — the run's `keyField` (process_key) has NO `_urban_instance_state` row at all, so the
 *  instance is absent/unknown in engine truth (engine clean-reset, cluster rebuild, or read-model
 *  pruning removed the instance-state row entirely — issue #630). Deliberately DISTINCT from
 *  {@link RECONCILE_ORPHAN_REASON} so an operator can tell an epoch-regression orphan apart from a
 *  vanished-instance orphan, even though both land on the same `orphaned` terminal. */
export const RECONCILE_VANISHED_REASON = "engine-instance/vanished";

/** The default grace window (ms) a dispatched-but-instance-less row is spared before it is considered
 *  vanished. A run dispatched moments ago (its `process_key` set) has not yet been polled into
 *  `_urban_instance_state` by the instanceTracking reconciler (`pollMs` 5s + engine search latency),
 *  so it transiently looks "vanished". This window (comfortably larger than a poll cycle) keeps a
 *  legitimately-still-starting run from being folded to terminal prematurely (issue #630 AC #2). */
export const DEFAULT_VANISHED_GRACE_MS = 5 * 60_000;

/** The framework's canonical per-instance engine-lifecycle projection table (urban's
 *  `_urban_instance_state`, keyed by `process_instance_key`). The vanished-instance reconcile joins
 *  each engine-backed row's `keyField` against it: a run whose key has NO row here has no backing
 *  instance in engine truth. `_urban_` prefixed (framework bookkeeping) so it is provisioned by the
 *  runtime, not our migrations — the reconcile guards on its existence before acting. */
const INSTANCE_STATE_TABLE = "_urban_instance_state";

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
export type ReconcileReason =
  | "epoch-regression"
  | "seed-epoch"
  | "no-op"
  | "engine-unreachable"
  | "instance-vanished";

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

/** Options for the vanished-instance reconcile pass ({@link reconcileVanishedInstances}). */
export interface VanishedReconcileOptions extends ReconcileOptions {
  /** How long (ms) a dispatched-but-instance-less row is spared before it is folded to terminal, so a
   *  still-starting run (not yet projected into `_urban_instance_state`) is not orphaned prematurely.
   *  Defaults to {@link DEFAULT_VANISHED_GRACE_MS}. */
  graceMs?: number;
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

/** The resolved schema + tracking selectors for one engine-backed binding, or `null` when the binding
 *  carries no `activeStatuses` selector (it cannot classify "in-flight", so it is skipped). */
interface BindingShape {
  table: string;
  active: readonly string[];
  statusField: string;
  keyField: string;
  pkCol: string;
  hasUpdatedAt: boolean;
}

/** The shape of a row selected for possible orphaning. */
interface OrphanCandidate {
  __pk: unknown;
  __key: unknown;
  __status: unknown;
  __updated?: unknown;
}

/** Resolve a binding's tracking selectors + physical schema, or `null` to skip a selector-less
 *  binding (activeStatusesFor would throw; we tolerate it here). */
async function resolveShape(src: DataSource, binding: InstanceTracking): Promise<BindingShape | null> {
  if (!binding.activeStatuses?.length) return null;
  const table = binding.table;
  const { pkCol, hasUpdatedAt } = await tableShape(src, table);
  return {
    table,
    active: activeStatusesFor(table),
    statusField: baseStatusFieldFor(table),
    keyField: keyFieldFor(table),
    pkCol,
    hasUpdatedAt,
  };
}

/** Drive ONE candidate row to `orphaned` with provenance, GUARDED: the UPDATE re-asserts the exact
 *  status read AND a populated key (plus any `extraGuardSql`, e.g. the still-vanished re-check), so a
 *  writer that flipped the row to a newer terminal status (or an instance that reappeared) between the
 *  SELECT and this UPDATE wins the race — we never clobber that history back to `orphaned`. Only a row
 *  we actually transitioned (`res.changed > 0`) gets provenance and is returned. `updated_at` is
 *  stamped (when the table has one) so the transition refreshes the row's timestamp like every other
 *  status transition in the codebase. Runs inside the caller's transaction. */
async function orphanRow(
  src: DataSource,
  shape: BindingShape,
  row: OrphanCandidate,
  reason: string,
  observedEpoch: number | null,
  runId: string,
  at: string,
  extraGuardSql = "",
): Promise<OrphanedRow | null> {
  const { table, pkCol, statusField, keyField, hasUpdatedAt } = shape;
  const pk = String(row.__pk);
  const key = row.__key == null ? null : String(row.__key);
  const fromStatus = String(row.__status);
  const res = await src.exec(
    `UPDATE ${q(table)} SET ${q(statusField)} = ?` +
      (hasUpdatedAt ? `, ${q(UPDATED_AT_COLUMN)} = ?` : "") +
      ` WHERE ${q(pkCol)} = ? AND ${q(statusField)} = ? AND ${q(keyField)} IS NOT NULL${extraGuardSql}`,
    hasUpdatedAt ? [ORPHANED_STATUS, at, row.__pk, fromStatus] : [ORPHANED_STATUS, row.__pk, fromStatus],
  );
  if (res.changed <= 0) return null;
  await src.exec(
    `INSERT INTO ${PROVENANCE_TABLE} ` +
      `(run_id, source_table, pk_value, key_value, from_status, to_status, reason, observed_epoch, at) ` +
      `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [runId, table, pk, key, fromStatus, ORPHANED_STATUS, reason, observedEpoch, at],
  );
  return { table, pk, key, fromStatus };
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
    const shape = await resolveShape(src, binding);
    if (!shape) continue;
    const placeholders = shape.active.map(() => "?").join(", ");
    const rows = await src.query<OrphanCandidate>(
      `SELECT ${q(shape.pkCol)} AS __pk, ${q(shape.keyField)} AS __key, ${q(shape.statusField)} AS __status ` +
        `FROM ${q(shape.table)} WHERE ${q(shape.statusField)} IN (${placeholders}) AND ${q(shape.keyField)} IS NOT NULL`,
      [...shape.active],
    );
    for (const row of rows) {
      const o = await orphanRow(src, shape, row, RECONCILE_ORPHAN_REASON, observedEpoch, runId, at);
      if (o) orphaned.push(o);
    }
  }
  return orphaned;
}

/** Whether a row's `updated_at` is younger than the grace window — i.e. it was (re)dispatched too
 *  recently to have been projected into `_urban_instance_state` yet, so it must NOT be folded. A
 *  null/unparseable timestamp is treated as "old enough" (not within grace): a dispatched row with no
 *  usable age and no backing instance is genuinely vanished. */
function withinGrace(updated: unknown, nowMs: number, graceMs: number): boolean {
  if (updated == null) return false;
  const t = Date.parse(String(updated));
  return Number.isFinite(t) && nowMs - t < graceMs;
}

/** Orphan every NON-terminal, engine-backed row whose `keyField` (process instance key) has NO
 *  `_urban_instance_state` row — the instance is absent/unknown in engine truth (vanished, issue
 *  #630) — and whose last transition is older than the grace window. Records one
 *  `reconcile_provenance` row per transition (reason {@link RECONCILE_VANISHED_REASON}). Runs inside
 *  the caller's transaction. */
async function orphanVanishedRows(
  src: DataSource,
  runId: string,
  at: string,
  nowMs: number,
  graceMs: number,
): Promise<OrphanedRow[]> {
  const orphaned: OrphanedRow[] = [];
  for (const binding of engineBackedBindings()) {
    const shape = await resolveShape(src, binding);
    if (!shape) continue;
    const placeholders = shape.active.map(() => "?").join(", ");
    const updatedSel = shape.hasUpdatedAt ? `, ${q(UPDATED_AT_COLUMN)} AS __updated` : "";
    // Active, dispatched (key populated) rows whose engine instance key has NO matching
    // `_urban_instance_state` row — absent/unknown in engine truth.
    const rows = await src.query<OrphanCandidate>(
      `SELECT ${q(shape.pkCol)} AS __pk, ${q(shape.keyField)} AS __key, ${q(shape.statusField)} AS __status${updatedSel} ` +
        `FROM ${q(shape.table)} b WHERE ${q(shape.statusField)} IN (${placeholders}) AND ${q(shape.keyField)} IS NOT NULL ` +
        `AND NOT EXISTS (SELECT 1 FROM ${q(INSTANCE_STATE_TABLE)} s WHERE s.process_instance_key = b.${q(shape.keyField)})`,
      [...shape.active],
    );
    // Re-assert "still no instance-state row" in the guarded UPDATE too, so an instance that reappears
    // (the poller records it) between the SELECT above and the UPDATE wins the race.
    const stillVanishedGuard =
      ` AND NOT EXISTS (SELECT 1 FROM ${q(INSTANCE_STATE_TABLE)} s ` +
      `WHERE s.process_instance_key = ${q(shape.table)}.${q(shape.keyField)})`;
    for (const row of rows) {
      if (shape.hasUpdatedAt && withinGrace(row.__updated, nowMs, graceMs)) continue;
      const o = await orphanRow(src, shape, row, RECONCILE_VANISHED_REASON, null, runId, at, stillVanishedGuard);
      if (o) orphaned.push(o);
    }
  }
  return orphaned;
}

/** Whether the framework `_urban_instance_state` projection exists in this source. When it does NOT,
 *  the vanished-instance pass is a hard no-op: without the projection every dispatched row would look
 *  "vanished", so we must never orphan on its absence. */
async function instanceStateTableExists(src: DataSource): Promise<boolean> {
  const rows = await src.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [INSTANCE_STATE_TABLE],
  );
  return rows.length > 0 && Number(rows[0].n) > 0;
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
 *
 * This surface is deliberately EPOCH-SCOPED: it only ever acts on the epoch signal. An engine that
 * is reachable but exposes NO epoch and for which none was ever recorded (observed == null AND
 * recorded == null) is, by contract, an intentional no-op — we have no reset signal to act on, and
 * we never orphan live work speculatively. Converging engine-backed rows against an engine with no
 * epoch support (e.g. via a per-instance existence probe) is out of contract for this surface.
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

/**
 * Reconcile engine-backed inflight work against the framework's canonical per-instance projection
 * (`_urban_instance_state`) — the "instance absent/unknown" gap (issue #630), DISTINCT from the
 * epoch-regression reset the {@link reconcileEngineBackedWork} pass handles.
 *
 * When an engine instance VANISHES from the read model — engine clean-reset, cluster rebuild, or
 * read-model pruning removes the `_urban_instance_state` row entirely — there is no `TERMINATED` row
 * for the derived tracking edge to match, so the run freezes at its last worker-owned status
 * (`escalated`/`awaiting_operator`) and wedges the Active list forever with no reconciliation path.
 * "The instance backing this run no longer exists in engine truth" is a terminal condition: this pass
 * drives every such row (active, dispatched, its `keyField` absent from `_urban_instance_state`, and
 * past the grace window) to the defined `orphaned` terminal WITH PROVENANCE.
 *
 * Safety:
 *   • GRACE WINDOW — a just-dispatched run has not yet been polled into `_urban_instance_state`; only
 *     rows whose last transition is older than `graceMs` are folded, so a still-starting run is never
 *     prematurely orphaned (AC #2).
 *   • PROJECTION-PRESENT — if `_urban_instance_state` does not exist (the runtime has not provisioned
 *     it), every dispatched row would look vanished, so the pass is a hard no-op.
 *   • GUARDED — the same status-re-assert as the epoch pass, plus a still-vanished re-check, so a
 *     concurrent terminal write or a reappearing instance wins the race.
 *   • This pass reads the app's OWN last-known projection, not a live probe, so it acts correctly on a
 *     genuinely-vanished instance regardless of transient engine reachability (a live instance keeps
 *     its persisted ACTIVE row across a restart, so it is never mistaken for vanished).
 */
export async function reconcileVanishedInstances(
  data: DataLayer,
  opts: VanishedReconcileOptions = {},
): Promise<ReconcileResult> {
  const src = data.open(opts.sourceName);
  const clock = opts.now?.() ?? new Date();
  const at = clock.toISOString();
  const nowMs = clock.getTime();
  const runId = opts.runId ?? crypto.randomUUID();
  const graceMs = opts.graceMs ?? DEFAULT_VANISHED_GRACE_MS;

  // Without the framework projection we cannot tell a vanished instance from a live one — every
  // dispatched row would look vanished. NO-OP rather than orphan live work.
  if (!(await instanceStateTableExists(src))) {
    await recordRun(src, { runId, at, observedEpoch: null, recordedEpoch: null, reason: "no-op", orphanedCount: 0 });
    opts.log?.info(`reconcile(vanished): instance-state projection absent — no-op [run ${runId}].`);
    return { runId, reason: "no-op", observedEpoch: null, recordedEpoch: null, orphanedCount: 0, orphaned: [] };
  }

  const orphaned = await src.tx(async (t) => {
    const rows = await orphanVanishedRows(t, runId, at, nowMs, graceMs);
    const reason: ReconcileReason = rows.length > 0 ? "instance-vanished" : "no-op";
    await recordRun(t, { runId, at, observedEpoch: null, recordedEpoch: null, reason, orphanedCount: rows.length });
    return rows;
  });

  if (orphaned.length > 0) {
    opts.log?.warn(
      `reconcile(vanished): orphaned ${orphaned.length} inflight row(s) whose engine instance ` +
        `vanished from the read model [run ${runId}].`,
    );
  } else {
    opts.log?.info(`reconcile(vanished): no vanished instances — no-op [run ${runId}].`);
  }
  return {
    runId,
    reason: orphaned.length > 0 ? "instance-vanished" : "no-op",
    observedEpoch: null,
    recordedEpoch: null,
    orphanedCount: orphaned.length,
    orphaned,
  };
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
 *  `reconcileEngineState` operator command share, so the two paths can never diverge. Runs BOTH the
 *  epoch-regression pass (engine reset/rewind) and the vanished-instance pass (an inflight run whose
 *  instance is absent/unknown in `_urban_instance_state` — issue #630), returning ONE merged result:
 *  the epoch decision drives the reason unless only the vanished pass acted, and `orphanedCount` /
 *  `orphaned` cover both. The two passes never double-fold a row: once the epoch pass orphans a row it
 *  leaves `activeStatuses`, so the vanished pass no longer selects it. */
export async function runEngineReconcile(
  data: DataLayer,
  engineRest: { restAddress: string; token?: string },
  opts: VanishedReconcileOptions & { fetchImpl?: typeof fetch } = {},
): Promise<ReconcileResult> {
  const observation = await probeEngineEpoch(engineRest.restAddress, {
    token: engineRest.token,
    fetchImpl: opts.fetchImpl,
  });
  const epoch = await reconcileEngineBackedWork(data, observation, opts);
  // A distinct run id so the vanished pass's `reconcile_runs`/provenance rows never collide with the
  // epoch pass's (run_id is a PRIMARY KEY). DERIVE it from the epoch pass's resolved run id — which is
  // also the merged result's `runId` — so it is `<runId>-vanished` on EVERY path, including the boot
  // path where `opts.runId` is omitted (a bare random UUID here would be non-correlatable to the
  // returned `runId`). Operators can always locate the vanished pass's provenance from the reported id.
  const vanished = await reconcileVanishedInstances(data, {
    ...opts,
    runId: `${epoch.runId}-vanished`,
  });

  const orphaned = [...epoch.orphaned, ...vanished.orphaned];
  const reason: ReconcileReason =
    epoch.reason === "epoch-regression"
      ? "epoch-regression"
      : vanished.orphanedCount > 0
        ? "instance-vanished"
        : epoch.reason;
  return {
    runId: epoch.runId,
    reason,
    observedEpoch: epoch.observedEpoch,
    recordedEpoch: epoch.recordedEpoch,
    orphanedCount: orphaned.length,
    orphaned,
  };
}
