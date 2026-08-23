// Test-only helper: make a hand-rolled fake `DataLayer.table(name)` also serve the ADR-0065 derived
// tracking VIEWs (`<table>__tracking`) that the real `@nanobpm/urban` runtime auto-provisions.
//
// The app's terminal-edge readers (app/abandon.ts, app/lineage.ts, app/conformance.ts, app/retro.ts,
// app/service.ts) route through `<table>__tracking` and read `derived_status`. The in-memory fakes in
// the unit tests only model base tables keyed by name, so a read of `pull_requests__tracking` would
// hit an empty store. Wrapping a fake's `table` resolver with `withTrackingViews` transparently
// aliases any tracking VIEW onto its base store and projects the derived column.
//
// Fidelity: a fake has no engine instance-state, so it can only compute the VIEW's `ELSE
// base.<statusField>` fall-through branch — which is exactly how these tests model an already-settled
// PR (they seed the terminal directly onto the base row). So `derived_status := base.<statusField>`
// reproduces the real view's pass-through semantics for the states unit tests exercise, with zero
// duplicated view-naming logic (it defers to the app's SSOT resolvers in app/instanceTracking.ts).
import { baseStatusFieldFor, baseTableForTrackingView, trackingTargetFor } from "../app/instanceTracking.ts";

// deno-lint-ignore no-explicit-any
type TableFn = (name: string, pk?: string) => any;

/** Decorate a fake `table(name, pk)` resolver so it also serves every `<table>__tracking` derived
 * VIEW off the corresponding base store, projecting `derived_status := base.<statusField>` onto each
 * row the read methods (`findOne`/`get`/`find`/`all`) return. A non-tracking name is passed through
 * untouched, and the VIEW is read-only (writes are never wrapped). */
export function withTrackingViews<F extends TableFn>(base: F): F {
  return ((name: string, pk?: string) => {
    const baseName = baseTableForTrackingView(name);
    if (!baseName) return base(name, pk);
    const inner = base(baseName, pk);
    const derivedColumn = trackingTargetFor(baseName).statusColumn;
    const statusField = baseStatusFieldFor(baseName);
    // biome-ignore lint/suspicious/noExplicitAny: test-only projection over dynamic row shapes.
    const project = (row: any) =>
      row == null ? row : { ...row, [derivedColumn]: row[statusField] };
    // biome-ignore lint/suspicious/noExplicitAny: test-only Proxy over a dynamic DataLayer table.
    return new Proxy(inner, {
      get(target: any, prop: string) {
        const value = target[prop];
        if (typeof value !== "function") return value;
        const bound = value.bind(target);
        if (prop === "findOne" || prop === "get") {
          return async (...args: unknown[]) => project(await bound(...args));
        }
        if (prop === "find" || prop === "all") {
          return async (...args: unknown[]) => (await bound(...args)).map(project);
        }
        return bound;
      },
    });
  }) as F;
}
