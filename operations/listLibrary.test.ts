// Tests for GET /app/api/delivery-graph/library → `listLibrary` (issue #522, epic #519 S3). The read
// behind the Library App-View: every saved entry, newest first, carrying its full graph JSON.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi, DataLayer } from "@nanobpm/urban";
import { bootTestApp } from "@nanobpm/urban-testkit";
import { buildLibraryEntryRow, saveLibraryEntry } from "../app/deliveryGraphLibrary.ts";
import { noopLog } from "../test/log.ts";
import handler from "./listLibrary.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");
const GRAPH = JSON.stringify({ name: "runbook", nodes: [] });

async function withApp(fn: (app: AppApi, data: DataLayer) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-dgliblist-"));
  const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dir, "app.db")}` } });
  try {
    const edge = { data: app.db, log: noopLog() } as unknown as AppApi;
    await fn(edge, app.db);
  } finally {
    await app.stop?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

const req = { headers: new Headers() } as any;
async function call(app: AppApi) {
  return (await handler({ req, params: {}, query: {} } as any, app)) as any;
}

test("list-library: empty → count 0", async () => {
  await withApp(async (app) => {
    const res = await call(app);
    assertEquals(res.status, 200);
    assertEquals(res.body.count, 0);
    assertEquals(res.body.entries.length, 0);
  });
});

test("list-library: saved entries returned newest-first with their graph JSON", async () => {
  await withApp(async (app, data) => {
    await saveLibraryEntry(data, buildLibraryEntryRow({ name: "older", graphJson: GRAPH, source: "composed", createdAt: "2024-01-01T00:00:00.000Z" }));
    await saveLibraryEntry(data, buildLibraryEntryRow({ name: "newer", graphJson: GRAPH, source: "imported", createdAt: "2024-06-01T00:00:00.000Z" }));
    const res = await call(app);
    assertEquals(res.status, 200);
    assertEquals(res.body.count, 2);
    assertEquals(res.body.entries[0].name, "newer");
    assertEquals(res.body.entries[1].name, "older");
    assertEquals(res.body.entries[0].graph, GRAPH);
    assertEquals(res.body.entries[0].createdAt, "2024-06-01T00:00:00.000Z");
    assert(typeof res.body.entries[0].updatedAt === "string");
  });
});
