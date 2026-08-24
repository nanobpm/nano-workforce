// Tests for POST /app/api/actions/delivery-graph/library/import → `importToLibrary` (issue #524, epic
// #519 S5). Covers the three required paths: a valid file → 200, saved with source=imported; a file that
// is not valid JSON → 400, nothing saved; a valid-JSON but UNCOMPILABLE graph → 400 with path-qualified
// errors, nothing saved. Exercised against the REAL SQLite data layer so the migration + store
// round-trip is validated, not modelled — mirroring saveToLibrary.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi, DataLayer } from "@nanobpm/urban";
import { bootTestApp } from "@nanobpm/urban-testkit";
import { deliveryGraphLibrary } from "../app/deliveryGraphLibrary.ts";
import { noopLog } from "../test/log.ts";
import handler from "./importToLibrary.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");

async function withApp(fn: (app: AppApi, data: DataLayer) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-dglibimport-"));
  const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dir, "app.db")}` } });
  try {
    const edge = { data: app.db, log: noopLog() } as unknown as AppApi;
    await fn(edge, app.db);
  } finally {
    await app.stop?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function call(app: AppApi, body: unknown) {
  return (await handler({ req: {} as any, params: {}, query: {}, body } as any, app)) as any;
}

const GOOD = JSON.stringify({
  name: "imported-runbook",
  nodes: [
    { id: "a", kind: "agent", agent: { jobType: "senior:feature" } },
    { id: "b", kind: "human", human: { prompt: "do X" } },
  ],
  edges: [{ from: "a", to: "b" }],
});

test("import-to-library: a valid file → 200, saved with source=imported, name from the graph", async () => {
  await withApp(async (app, data) => {
    const res = await call(app, { graphJson: GOOD });
    assertEquals(res.status, 200);
    assertEquals(res.body.ok, true);
    assertEquals(res.body.entry.source, "imported");
    assertEquals(res.body.entry.name, "imported-runbook");
    assert(res.body.entry.id.startsWith("imported-runbook-"));
    assert(typeof res.body.entry.graph === "string" && res.body.entry.graph.length > 0);
    // Persisted exactly one row.
    assertEquals((await deliveryGraphLibrary(data).all()).length, 1);
    assertEquals((await deliveryGraphLibrary(data).get(res.body.entry.id))?.source, "imported");
  });
});

test("import-to-library: an explicit name overrides the graph's own name", async () => {
  await withApp(async (app, data) => {
    const res = await call(app, { graphJson: GOOD, name: "My Import", description: "from disk" });
    assertEquals(res.status, 200);
    assertEquals(res.body.entry.name, "My Import");
    assertEquals(res.body.entry.description, "from disk");
    assert(res.body.entry.id.startsWith("my-import-"));
    assertEquals((await deliveryGraphLibrary(data).all()).length, 1);
  });
});

test("import-to-library: a file that isn't valid JSON → 400, nothing persisted", async () => {
  await withApp(async (app, data) => {
    const res = await call(app, { graphJson: "{ not json" });
    assertEquals(res.status, 400);
    assertEquals(res.body.ok, false);
    assert(typeof res.body.error === "string" && res.body.error.includes("not valid JSON"));
    assertEquals((await deliveryGraphLibrary(data).all()).length, 0);
  });
});

test("import-to-library: an empty file → 400, nothing persisted", async () => {
  await withApp(async (app, data) => {
    const res = await call(app, { graphJson: "   " });
    assertEquals(res.status, 400);
    assertEquals(res.body.ok, false);
    assertEquals((await deliveryGraphLibrary(data).all()).length, 0);
  });
});

test("import-to-library: a valid-JSON but UNCOMPILABLE graph → 400 with path-qualified errors, nothing persisted", async () => {
  await withApp(async (app, data) => {
    // A structurally-invalid graph (edge references a node that does not exist) fails compilation.
    const uncompilable = JSON.stringify({
      name: "broken",
      nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:feature" } }],
      edges: [{ from: "a", to: "missing" }],
    });
    const res = await call(app, { graphJson: uncompilable });
    assertEquals(res.status, 400);
    assertEquals(res.body.ok, false);
    assert(Array.isArray(res.body.errors) && res.body.errors.length > 0);
    assert(
      res.body.errors.every(
        (e: { path: string; message: string }) => typeof e.path === "string" && e.path.trim().length > 0,
      ),
    );
    assertEquals((await deliveryGraphLibrary(data).all()).length, 0);
  });
});

test("import-to-library: an unnamed graph with no override → 400, nothing persisted", async () => {
  await withApp(async (app, data) => {
    // A graph with no `name` cannot derive a library id and no override was supplied.
    const unnamed = JSON.stringify({
      nodes: [{ id: "a", kind: "human", human: { prompt: "do X" } }],
      edges: [],
    });
    const res = await call(app, { graphJson: unnamed });
    assertEquals(res.status, 400);
    assertEquals(res.body.ok, false);
    assertEquals((await deliveryGraphLibrary(data).all()).length, 0);
  });
});
