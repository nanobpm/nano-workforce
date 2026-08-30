// nano-workforce — the app's single accessor for the `instanceTracking` derived read models
// (ADR 0065, the writer→source inversion adopted with `@nanobpm/urban@0.81.0`).
//
// Since ADR 0065 the `instanceTracking` reconciler is a SOURCE, not a writer: on each poll it feeds
// engine truth into urban's canonical projections (`urban_instance_state`, `urban_open_user_tasks`)
// and NO LONGER writes the terminal (`onTerminated.set`) / wait-on-human (`onWaitingHuman.set`)
// edges onto the app's base row. Those edges are now DERIVED — recomputed on every read — by an
// auto-provisioned managed VIEW `<table>__tracking` whose `derived_status` column is
// `CASE WHEN terminated THEN <onTerminated value> WHEN waiting-human THEN <onWaitingHuman value>
// ELSE base.<statusField> END`. So the base `statusField` keeps only the worker-owned transient
// status, and any reader that used to rely on the reconciler having written the terminal status
// onto the base row must read `derived_status` off the VIEW instead.
//
// This module is the ONE place that:
//   - parses the `instanceTracking` bindings from `nano.app.json` (the single source of truth), and
//   - resolves each binding's derived VIEW name + `derived_status` column via urban's OWN target
//     resolver (`instanceTrackingReadModelTarget`), so the app can never drift from the framework's
//     view naming.
//
// Writers are unchanged: a service-task worker that owns a terminal outcome (`converged`, `merged`,
// `done`, …) still writes it to the base `data.table(<table>)`. Only readers that classify on the
// RECONCILER-derived edge (terminated → abandoned/failed/reviewed, or waiting-human →
// awaiting_operator) route through the derived VIEW here.

import { readFileSync } from "node:fs";
import {
  type AppManifest,
  type DataLayer,
  type InstanceTracking,
  instanceTrackingReadModelTarget,
  type Table,
} from "@nanobpm/urban";

/** The app manifest, parsed exactly ONCE at module load, typed by urban's own `AppManifest` so the
 *  binding shape can never drift from the framework's schema. */
const APP_MANIFEST: AppManifest = JSON.parse(
  readFileSync(new URL("../nano.app.json", import.meta.url), "utf8"),
);

/** The app manifest's `instanceTracking` bindings — the single source of truth for the derived
 *  read-model registry. */
const INSTANCE_TRACKING_BINDINGS: readonly InstanceTracking[] = APP_MANIFEST.instanceTracking ?? [];

/** The single `instanceTracking` binding for a base table, or throw if the manifest has none. */
export function trackingBindingFor(table: string): InstanceTracking {
  const binding = INSTANCE_TRACKING_BINDINGS.find((b) => b.table === table);
  if (!binding) {
    throw new Error(`nano.app.json: no instanceTracking binding for table "${table}"`);
  }
  return binding;
}

/** A tracked table's parked-and-active statuses, from the single source of truth
 *  (`instanceTracking.<table>.activeStatuses` in nano.app.json), so an app-side scan can never drift
 *  from the reconciler's notion of "in-flight". Throws if the binding is missing/empty. */
export function activeStatusesFor(table: string): readonly string[] {
  const binding = trackingBindingFor(table);
  if (!binding.activeStatuses?.length) {
    throw new Error(
      `nano.app.json: instanceTracking[table="${table}"].activeStatuses is missing or empty`,
    );
  }
  return binding.activeStatuses;
}

/** A tracked table's engine-instance key column (the `keyField` in nano.app.json — e.g.
 *  `process_key`), the single source of truth the app-side reconcile probes/orphans by so it can
 *  never drift from the reconciler's notion of "which column holds the engine instance key". */
export function keyFieldFor(table: string): string {
  return trackingBindingFor(table).keyField;
}

/** Every `instanceTracking` binding — the full registry of ENGINE-BACKED base tables (each row is
 *  projected off a live engine process instance keyed by `keyField`). The app-side engine-reset
 *  reconcile (app/reconcile.ts) scans exactly this set: a row whose `statusField` is still in the
 *  binding's `activeStatuses` and whose `keyField` is populated is non-terminal engine-backed work,
 *  the only surface reconcile may drive to `orphaned`. Terminal rows and non-engine-backed surfaces
 *  (presence, append-only audit) are, by construction, not in this set and are never touched. */
export function engineBackedBindings(): readonly InstanceTracking[] {
  return INSTANCE_TRACKING_BINDINGS;
}

/** The managed derived read-model VIEW name + effective-status column for a base table, resolved by
 *  urban's OWN target resolver so the app never drifts from the framework's `<table>__tracking` /
 *  `derived_status` naming (ADR 0065). */
export function trackingTargetFor(table: string): { view: string; statusColumn: string } {
  return instanceTrackingReadModelTarget(trackingBindingFor(table));
}

/** The base table a derived tracking VIEW projects, or undefined when `view` is not a tracking view.
 * The inverse of {@link trackingTargetFor}, resolved off the same binding registry so it can't drift
 * from the framework's view naming. */
export function baseTableForTrackingView(view: string): string | undefined {
  return INSTANCE_TRACKING_BINDINGS.find((b) => trackingTargetFor(b.table).view === view)?.table;
}

/** The base `statusField` a binding's derived edge falls through to when no terminal/wait edge
 * applies (the VIEW's `ELSE base.<statusField>` branch). Defaults to `"status"`, mirroring urban. */
export function baseStatusFieldFor(table: string): string {
  return trackingBindingFor(table).statusField ?? "status";
}

/** A read-only typed gateway over a tracked table's derived VIEW (`<table>__tracking`). The VIEW
 *  re-exports `base.*` plus the derived `derived_status` column, so a row carries BOTH the base
 *  transient `<statusField>` and the effective (ADR-0065-derived) `derived_status`. Read
 *  `derived_status` to classify on the terminal / wait-on-human edge; urban forbids writing a VIEW,
 *  so use `data.table(<table>)` for writes. `T` should include `derived_status: string`. */
export function derivedTrackingTable<T extends object>(
  data: DataLayer,
  table: string,
  pk: string,
): Table<T> {
  return data.table<T>(trackingTargetFor(table).view, pk);
}
