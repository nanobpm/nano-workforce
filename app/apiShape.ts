// Camunda-aligned API response/request shapes (Part of #972 — see docs/api-conventions.md).
//
// The ONE implementation of the additive (non-breaking) step of the API normalisation:
//   • `listEnvelope` — the Camunda list shape `{ items, page: { totalItems } }` every list operation
//     returns NEXT TO its deprecated legacy array + `count`.
//   • `withProcessInstanceKey` — mirror a row's deprecated `processKey` (the engine process-instance
//     key) onto the canonical `processInstanceKey`, so both ride the wire until the legacy name is
//     removed.
//   • `pickKey` — request dual-accept: read the canonical name first, falling back to a deprecated
//     synonym (canonical wins when both are present).
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

/** Add the canonical `processInstanceKey` alongside a row's deprecated `processKey`. */
export function withProcessInstanceKey<T extends { processKey?: string | null }>(
  row: T,
): T & { processInstanceKey: string | null } {
  return { ...row, processInstanceKey: row.processKey ?? null };
}

/** Request dual-accept: the first non-blank string among `names` (canonical name first). */
export function pickKey(src: unknown, ...names: string[]): string {
  if (typeof src !== "object" || src === null) return "";
  for (const name of names) {
    const v: unknown = Reflect.get(src, name);
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "";
}
