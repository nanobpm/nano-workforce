// Tests for DELETE /app/api/delivery-graph/library/{id} → `deleteLibraryEntry` (issue #522, epic #519
// S3). Idempotent delete: a known id is removed (`deleted:true`); an unknown / already-gone id is a
// clean no-op (`deleted:false`), never an error.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { AppApi, DataLayer } from "@nanobpm/urban";
import { bootTestApp } from "@nanobpm/urban-testkit";
import { buildLibraryEntryRow, deliveryGraphLibrary, saveLibraryEntry } from "../app/deliveryGraphLibrary.ts";
import { noopLog } from "../test/log.ts";
import handler from "./deleteLibraryEntry.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");
const GRAPH = JSON.stringify({ name: "runbook", nodes: [] });

async function withApp(fn: (app: AppApi, data: DataLayer) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-dglibdel-"));
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
async function call(app: AppApi, id: string) {
  return (await handler({ req, params: { id }, query: {} } as any, app)) as any;
}

test("delete-library-entry: a known id → 200 deleted:true and the row is gone", async () => {
  await withApp(async (app, data) => {
    const saved = await saveLibraryEntry(data, buildLibraryEntryRow({ name: "runbook", graphJson: GRAPH, source: "composed" }));
    const res = await call(app, saved.id);
    assertEquals(res.status, 200);
    assertEquals(res.body.ok, true);
    assertEquals(res.body.deleted, true);
    assertEquals((await deliveryGraphLibrary(data).all()).length, 0);
  });
});

test("delete-library-entry: an unknown id → 200 deleted:false (idempotent no-op)", async () => {
  await withApp(async (app) => {
    const res = await call(app, "no-such-id");
    assertEquals(res.status, 200);
    assertEquals(res.body.ok, true);
    assertEquals(res.body.deleted, false);
  });
});

test("delete-library-entry: a re-delete of an already-gone id → deleted:false", async () => {
  await withApp(async (app, data) => {
    const saved = await saveLibraryEntry(data, buildLibraryEntryRow({ name: "runbook", graphJson: GRAPH, source: "composed" }));
    assertEquals((await call(app, saved.id)).body.deleted, true);
    assertEquals((await call(app, saved.id)).body.deleted, false);
  });
});
