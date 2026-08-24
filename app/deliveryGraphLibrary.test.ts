// Unit coverage for the reusable delivery-graph LIBRARY aggregate (app/deliveryGraphLibrary.ts, issue
// #522, epic #519 S3). Two layers: the PURE helpers (slugify, name-derived id, row builder) tested in
// isolation, and the I/O (`saveLibraryEntry` upsert-on-name identity, `listLibraryEntries` newest-first,
// `getLibraryEntry`, `deleteLibraryEntry` idempotence) exercised against the REAL provisioned SQLite
// data layer so the migration + raw table ops are validated, not modelled.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import { bootTestApp } from "@nanobpm/urban-testkit";
import {
  buildLibraryEntryRow,
  deleteLibraryEntry,
  deliveryGraphLibrary,
  getLibraryEntry,
  libraryEntryId,
  listLibraryEntries,
  saveLibraryEntry,
  slugifyName,
} from "./deliveryGraphLibrary.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");

async function withData(fn: (data: DataLayer) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-dglib-"));
  const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dir, "app.db")}` } });
  try {
    await fn(app.db);
  } finally {
    await app.stop?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

const GRAPH = JSON.stringify({ name: "runbook", nodes: [] });

// ── pure helpers ──────────────────────────────────────────────────────────────
test("slugifyName: lowercases, collapses non-alphanumerics to single dashes, trims", () => {
  assertEquals(slugifyName("Runbook A"), "runbook-a");
  assertEquals(slugifyName("  My  Graph!! "), "my-graph");
  assertEquals(slugifyName("weird__name.v2"), "weird-name-v2");
});

test("slugifyName: a name with no alphanumerics falls back to `graph`", () => {
  assertEquals(slugifyName("   "), "graph");
  assertEquals(slugifyName("***"), "graph");
});

test("libraryEntryId: `<slug>-<8-hex>`, stable per name and trimmed identically", () => {
  const id = libraryEntryId("Runbook A");
  assert(/^runbook-a-[0-9a-f]{8}$/.test(id), `unexpected id: ${id}`);
  // Deterministic + whitespace-insensitive (trimmed to the same identity).
  assertEquals(libraryEntryId("Runbook A"), id);
  assertEquals(libraryEntryId("  Runbook A  "), id);
});

test("libraryEntryId: names that slugify the same are disambiguated by the name hash", () => {
  // Both slugify to `runbook-a`, but the short hash keys off the ORIGINAL trimmed name.
  const a = libraryEntryId("Runbook A");
  const b = libraryEntryId("runbook.a");
  assert(a.startsWith("runbook-a-"));
  assert(b.startsWith("runbook-a-"));
  assert(a !== b, "distinct names must yield distinct ids even when their slugs match");
});

test("buildLibraryEntryRow: derives id from name, normalises a blank description to null", () => {
  const row = buildLibraryEntryRow({ name: "  runbook  ", description: "   ", graphJson: GRAPH, source: "composed" });
  assertEquals(row.id, libraryEntryId("runbook"));
  assertEquals(row.name, "runbook");
  assertEquals(row.description, null);
  assertEquals(row.source, "composed");
  assert(typeof row.created_at === "string" && row.created_at.length > 0);
  assertEquals(row.updated_at, row.created_at);
});

// ── I/O against the real data layer ─────────────────────────────────────────────
test("saveLibraryEntry: first save inserts; the row round-trips through get", async () => {
  await withData(async (data) => {
    const written = await saveLibraryEntry(
      data,
      buildLibraryEntryRow({ name: "runbook", description: "a note", graphJson: GRAPH, source: "composed" }),
    );
    const fetched = await getLibraryEntry(data, written.id);
    assert(fetched !== null);
    assertEquals(fetched?.name, "runbook");
    assertEquals(fetched?.description, "a note");
    assertEquals(fetched?.graph, GRAPH);
    assertEquals(fetched?.source, "composed");
  });
});

test("saveLibraryEntry: re-saving the same name UPSERTS (one row), refreshes graph, preserves created_at", async () => {
  await withData(async (data) => {
    const first = await saveLibraryEntry(
      data,
      buildLibraryEntryRow({ name: "runbook", graphJson: GRAPH, source: "composed", createdAt: "2024-01-01T00:00:00.000Z" }),
    );
    const editedGraph = JSON.stringify({ name: "runbook", nodes: [{ id: "a", kind: "human" }] });
    const second = await saveLibraryEntry(
      data,
      buildLibraryEntryRow({ name: "runbook", graphJson: editedGraph, source: "from-staged" }),
    );
    assertEquals(first.id, second.id);
    assertEquals((await deliveryGraphLibrary(data).all()).length, 1);
    const fetched = await getLibraryEntry(data, second.id);
    assertEquals(fetched?.graph, editedGraph);
    assertEquals(fetched?.source, "from-staged");
    // created_at is anchored to the first save; the graph edit did not move the row.
    assertEquals(fetched?.created_at, "2024-01-01T00:00:00.000Z");
  });
});

test("listLibraryEntries: every saved entry, newest first", async () => {
  await withData(async (data) => {
    await saveLibraryEntry(data, buildLibraryEntryRow({ name: "older", graphJson: GRAPH, source: "composed", createdAt: "2024-01-01T00:00:00.000Z" }));
    await saveLibraryEntry(data, buildLibraryEntryRow({ name: "newer", graphJson: GRAPH, source: "composed", createdAt: "2024-06-01T00:00:00.000Z" }));
    const list = await listLibraryEntries(data);
    assertEquals(list.length, 2);
    assertEquals(list[0].name, "newer");
    assertEquals(list[1].name, "older");
  });
});

test("deleteLibraryEntry: removes a known entry (true); a re-delete is an idempotent no-op (false)", async () => {
  await withData(async (data) => {
    const row = await saveLibraryEntry(data, buildLibraryEntryRow({ name: "runbook", graphJson: GRAPH, source: "composed" }));
    assertEquals(await deleteLibraryEntry(data, row.id), true);
    assertEquals(await getLibraryEntry(data, row.id), null);
    assertEquals(await deleteLibraryEntry(data, row.id), false);
    assertEquals(await deleteLibraryEntry(data, "no-such-id"), false);
  });
});
