// app/deliveryGraphLibrary.ts — the reusable delivery-graph LIBRARY aggregate (issue #522, epic #519
// S3). The durable base the Library App-View (S4/#523), filesystem import (S5/#524), and export
// (S6/#525) build on. It mirrors the `delivery_graph_proposals` store/door pattern
// (`app/deliveryGraphProposals.ts`) so downstream slices meet a familiar API surface — but with two
// deliberate differences that reflect what a library IS:
//
//   • Keyed by a slug + short-hash of the entry NAME (`libraryEntryId`), NOT the content digest.
//     Proposals are content-addressed (a re-compile is a new digest, a new row); a library entry is
//     meant to have its GRAPH edited in place — the NAME *is* the identity, so keying on the human,
//     readable name gives a stable, human-readable id and re-saving the same name is idempotent
//     (upsert: the graph refreshes, `created_at` is preserved). Because the id is derived from the
//     name, a rename is NOT an in-place update: it derives a *new* id (a new entry), leaving the old
//     row until it is explicitly deleted.
//   • NO TTL. A proposal ages out of the cockpit; a saved library entry is kept until explicitly
//     deleted — there is no `expires_at` and no sweep.
//
// The pure helpers (`slugifyName`, `libraryEntryId`, `buildLibraryEntryRow`) are DB-free so they
// unit-test in isolation; `saveLibraryEntry` / `listLibraryEntries` / `getLibraryEntry` /
// `deleteLibraryEntry` supply the I/O.

import { createHash } from "node:crypto";
import type { DataLayer } from "@nanobpm/urban";
import type { DeliveryGraphLibraryEntry as DeliveryGraphLibraryEntryDto } from "../nano-generated/api-io.d.ts";

const now = () => new Date().toISOString();

/** How a library entry entered the library. `composed` = saved from a raw graph JSON; `imported` =
 * loaded from the filesystem (S5/#524); `from-staged` / `from-dispatched` = saved from a staged or
 * dispatched proposal's digest (its already-stored graph reused). */
export const DELIVERY_LIBRARY_SOURCES = ["composed", "imported", "from-staged", "from-dispatched"] as const;
export type DeliveryLibrarySource = typeof DELIVERY_LIBRARY_SOURCES[number];

/** One saved library entry — the durable row keyed by name-derived `id`. `graph` is the serialised
 * `DeliveryGraph` JSON (validated/compiled before it is ever written). */
export interface DeliveryGraphLibraryEntry {
  id: string;
  name: string;
  description: string | null;
  graph: string;
  source: DeliveryLibrarySource;
  created_at: string;
  updated_at: string;
}

/** The `delivery_graph_library` aggregate accessor — the durable library store keyed by name-derived `id`. */
export const deliveryGraphLibrary = (data: DataLayer) =>
  data.table<DeliveryGraphLibraryEntry>("delivery_graph_library", "id");

/** Slugify a human name into an id-safe token: lowercased, non-alphanumerics collapsed to single `-`,
 * trimmed of leading/trailing `-`. A name with no alphanumerics (e.g. `"   "`) yields `"graph"` so the
 * id is always well-formed. */
export function slugifyName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "graph";
}

/** The stable, human-readable library id for a NAME — `<slug>-<sha256(name)[:8]>`. Derived from the
 * (mutable) name rather than the content, so an entry's graph can be edited without moving its row, and
 * re-saving the SAME name is idempotent (same id → upsert). The short hash disambiguates two names that
 * slugify to the same token (e.g. `"Runbook A"` vs `"runbook.a"`), keyed off the ORIGINAL trimmed name
 * so the id survives punctuation the slug drops. */
export function libraryEntryId(name: string): string {
  const trimmed = name.trim();
  const hash = createHash("sha256").update(trimmed).digest("hex").slice(0, 8);
  return `${slugifyName(trimmed)}-${hash}`;
}

/** Build a durable library row for a NAMED graph. `createdAt` is preserved across an idempotent re-save
 * of the same name (omit it — defaulting to now — for a first save). `graphJson` must already be a
 * validated/compiled `DeliveryGraph` serialisation (the door validates via `parseAndCompileText`). */
export function buildLibraryEntryRow(input: {
  name: string;
  description?: string | null;
  graphJson: string;
  source: DeliveryLibrarySource;
  createdAt?: string;
}): DeliveryGraphLibraryEntry {
  const at = now();
  const name = input.name.trim();
  const description = typeof input.description === "string" && input.description.trim() !== "" ? input.description.trim() : null;
  return {
    id: libraryEntryId(name),
    name,
    description,
    graph: input.graphJson,
    source: input.source,
    created_at: input.createdAt ?? at,
    updated_at: at,
  };
}

/** Persist a library entry, UPSERTing on its name-derived `id`. A first save inserts; a re-save of the
 * same name refreshes the graph/description/source and `updated_at` while PRESERVING the original
 * `created_at` — an edit updates in place, it does not create a duplicate. Because `created_at` is
 * preserved, a re-save never changes the entry's position in the newest-first list, regardless of
 * which fields (graph included) changed. Returns the written row. */
export async function saveLibraryEntry(data: DataLayer, row: DeliveryGraphLibraryEntry): Promise<DeliveryGraphLibraryEntry> {
  const table = deliveryGraphLibrary(data);
  const existing = await table.get(row.id);
  const toWrite: DeliveryGraphLibraryEntry = existing ? { ...row, created_at: existing.created_at } : row;
  if (existing) {
    const { id, ...patch } = toWrite;
    await table.update(row.id, patch);
  } else {
    await table.insert(toWrite);
  }
  return toWrite;
}

/** Every saved library entry, newest first. The Library App-View (S4/#523) polls this to render the
 * list. Read-only; no write. `DataLayer.all()` has no `ORDER BY` (see `app/lineage.ts`), so — like
 * every other read-projection in this app — we sort in memory. The library is a curated, small-
 * cardinality set (human-saved graphs), so the O(n log n) sort is not a hot path; the
 * `ix_delivery_graph_library_created` index is kept for a future DB-ordered read path. */
export async function listLibraryEntries(data: DataLayer): Promise<DeliveryGraphLibraryEntry[]> {
  const rows = await deliveryGraphLibrary(data).all();
  return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Load one library entry by its `id`, or null when unknown. */
export async function getLibraryEntry(data: DataLayer, id: string): Promise<DeliveryGraphLibraryEntry | null> {
  return (await deliveryGraphLibrary(data).get(id)) ?? null;
}

/** Delete one library entry by its `id`. Returns true when a row was removed, false when the id named
 * nothing (idempotent — a re-delete of an already-gone entry is a clean no-op). */
export async function deleteLibraryEntry(data: DataLayer, id: string): Promise<boolean> {
  const table = deliveryGraphLibrary(data);
  const existing = await table.get(id);
  if (!existing) return false;
  await table.delete(id);
  return true;
}

/** Project a durable library row into the operator-facing `DeliveryGraphLibraryEntry` DTO the doors
 * return — the single snake_case → camelCase mapping, so no door re-invents it (derivation over
 * duplication). The full `graph` JSON is carried so the export affordance (S6/#525) can build a
 * client-side download from a list payload without a second fetch. */
export function libraryEntryDto(row: DeliveryGraphLibraryEntry): DeliveryGraphLibraryEntryDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    graph: row.graph,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
