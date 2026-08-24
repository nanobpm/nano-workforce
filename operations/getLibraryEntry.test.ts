// Tests for GET /app/api/delivery-graph/library/{id} → `getLibraryEntry` (issue #522, epic #519 S3).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi, DataLayer } from "@nanobpm/urban";
import { bootTestApp } from "@nanobpm/urban-testkit";
import { buildLibraryEntryRow, saveLibraryEntry } from "../app/deliveryGraphLibrary.ts";
import { noopLog } from "../test/log.ts";
import handler from "./getLibraryEntry.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");
const GRAPH = JSON.stringify({ name: "runbook", nodes: [] });

async function withApp(fn: (app: AppApi, data: DataLayer) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-dglibget-"));
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

test("get-library-entry: a known id → 200 with the entry (including graph JSON)", async () => {
  await withApp(async (app, data) => {
    const saved = await saveLibraryEntry(data, buildLibraryEntryRow({ name: "runbook", graphJson: GRAPH, source: "composed" }));
    const res = await call(app, saved.id);
    assertEquals(res.status, 200);
    assertEquals(res.body.id, saved.id);
    assertEquals(res.body.name, "runbook");
    assertEquals(res.body.graph, GRAPH);
    assertEquals(res.body.source, "composed");
  });
});

test("get-library-entry: an unknown id → 404", async () => {
  await withApp(async (app) => {
    const res = await call(app, "no-such-id");
    assertEquals(res.status, 404);
    assert(typeof res.body.error === "string");
  });
});
