// Camunda-aligned API response/request shapes (Part of #972 — see docs/api-conventions.md).
//
// The ONE implementation of the Camunda-aligned wire shapes:
//   • `listEnvelope` — the Camunda list shape `{ items, page: { totalItems } }` every list operation
//     returns (the legacy per-list arrays + `count` were removed in the breaking step of #972).
//   • `withProcessInstanceKey` — rename a row's internal `processKey` (the engine process-instance
//     key) to the canonical `processInstanceKey` on the wire.
//   • `pickKey` — read the first non-blank string field among the given names.
// API surface only: internal DB columns (e.g. `process_key`) are untouched.

/** The Camunda page metadata on a list response. */
export interface ListPage {
  totalItems: number;
}

/** The Camunda list envelope. */
export interface ListEnvelope<T> {
  items: T[];
  page: ListPage;
}

/** Wrap an already-materialised list in the Camunda `{ items, page: { totalItems } }` envelope. */
export function listEnvelope<T>(items: readonly T[]): ListEnvelope<T> {
  return { items: [...items], page: { totalItems: items.length } };
}

/** Rename a row's internal `processKey` (the engine process-instance key) to the canonical
 * `processInstanceKey` on the wire — the internal name never reaches the API surface. */
export function withProcessInstanceKey<T extends { processKey?: string | null }>(
  row: T,
): Omit<T, "processKey"> & { processInstanceKey: string | null } {
  const { processKey, ...rest } = row;
  return { ...rest, processInstanceKey: processKey ?? null };
}

/** The first non-blank string field among `names`. */
export function pickKey(src: unknown, ...names: string[]): string {
  if (typeof src !== "object" || src === null) return "";
  for (const name of names) {
    const v: unknown = Reflect.get(src, name);
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "";
}
