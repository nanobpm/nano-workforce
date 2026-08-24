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

// The optional shared-secret guard is enforced in the handler (not by OpenAPI `security`), mirroring
// the other read doors. `SECRET` is captured at module import, so we cache-bust re-import the handler
// with NANO_PR_WEBHOOK_SECRET set to exercise both the rejected (401) and authorized (200) paths
// against a real booted data layer holding a known entry.
test("get-library-entry: shared-secret guard — 401 without x-hook-secret, 200 with it", async () => {
  await withApp(async (app, data) => {
    const saved = await saveLibraryEntry(data, buildLibraryEntryRow({ name: "runbook", graphJson: GRAPH, source: "composed" }));
    const prev = process.env["NANO_PR_WEBHOOK_SECRET"];
    process.env["NANO_PR_WEBHOOK_SECRET"] = "s3cr3t";
    try {
      const mod = await import(`./getLibraryEntry.ts?guard=${Date.now()}`);
      const guarded = mod.default as (c: any, a: any) => Promise<any>;
      const bad = await guarded({ req: { headers: new Headers() }, params: { id: saved.id }, query: {} } as any, app);
      assertEquals(bad.status, 401);
      const ok = await guarded({ req: { headers: new Headers({ "x-hook-secret": "s3cr3t" }) }, params: { id: saved.id }, query: {} } as any, app);
      assertEquals(ok.status, 200);
      assertEquals(ok.body.id, saved.id);
    } finally {
      if (prev === undefined) delete process.env["NANO_PR_WEBHOOK_SECRET"];
      else process.env["NANO_PR_WEBHOOK_SECRET"] = prev;
    }
  });
});
