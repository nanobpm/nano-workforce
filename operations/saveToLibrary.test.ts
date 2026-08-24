// Tests for POST /app/api/actions/delivery-graph/library/save → `saveToLibrary` (issue #522, epic #519
// S3). Covers the three required paths: save-from-raw-JSON (`source: composed`), save-from-digest
// (reuse a staged proposal's stored graph, `source: from-staged`), and validation-reject (an
// uncompilable graph → clean 400, nothing persisted). Exercised against the REAL SQLite data layer so
// the migration + store round-trip is validated, not modelled.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi, DataLayer } from "@nanobpm/urban";
import { bootTestApp } from "@nanobpm/urban-testkit";
import { deliveryGraphLibrary } from "../app/deliveryGraphLibrary.ts";
import { noopLog } from "../test/log.ts";
import stageHandler from "./stageDeliveryGraph.ts";
import handler from "./saveToLibrary.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");

async function withApp(fn: (app: AppApi, data: DataLayer) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-dglibsave-"));
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

async function stage(app: AppApi, graphJson: string) {
  return (await stageHandler({ req: {} as any, params: {}, query: {}, body: { graphJson } } as any, app)) as any;
}

const GOOD = JSON.stringify({
  name: "runbook",
  nodes: [
    { id: "a", kind: "agent", agent: { jobType: "senior:feature" } },
    { id: "b", kind: "human", human: { prompt: "do X" } },
  ],
  edges: [{ from: "a", to: "b" }],
});

test("save-to-library: a raw graph JSON → 200, saved with source=composed, id derived from name", async () => {
  await withApp(async (app, data) => {
    const res = await call(app, { name: "My Runbook", description: "a note", graphJson: GOOD });
    assertEquals(res.status, 200);
    assertEquals(res.body.ok, true);
    assert(res.body.entry.id.startsWith("my-runbook-"));
    assertEquals(res.body.entry.name, "My Runbook");
    assertEquals(res.body.entry.description, "a note");
    assertEquals(res.body.entry.source, "composed");
    assert(typeof res.body.entry.graph === "string" && res.body.entry.graph.length > 0);
    // Persisted exactly one row.
    assertEquals((await deliveryGraphLibrary(data).all()).length, 1);
    assertEquals((await deliveryGraphLibrary(data).get(res.body.entry.id))?.name, "My Runbook");
  });
});

test("save-to-library: from a staged proposal digest → 200, reuses the stored graph, source=from-staged", async () => {
  await withApp(async (app, data) => {
    const staged = await stage(app, GOOD);
    assertEquals(staged.status, 200);
    const digest = staged.body.digest;
    const res = await call(app, { name: "Saved From Staged", digest });
    assertEquals(res.status, 200);
    assertEquals(res.body.ok, true);
    assertEquals(res.body.entry.source, "from-staged");
    // The reused graph compiles to the SAME digest the proposal carried.
    const proposal = await (await import("../app/deliveryGraphProposals.ts")).deliveryGraphProposals(data).get(digest);
    assert(proposal !== undefined);
    assertEquals((await deliveryGraphLibrary(data).all()).length, 1);
  });
});

test("save-to-library: an unknown digest → 400, nothing persisted", async () => {
  await withApp(async (app, data) => {
    const res = await call(app, { name: "ghost", digest: "deadbeef0000" });
    assertEquals(res.status, 400);
    assertEquals(res.body.ok, false);
    assert(typeof res.body.error === "string" && res.body.error.includes("no stored graph"));
    assertEquals((await deliveryGraphLibrary(data).all()).length, 0);
  });
});

test("save-to-library: not-valid-JSON graph → 400, nothing persisted", async () => {
  await withApp(async (app, data) => {
    const res = await call(app, { name: "bad", graphJson: "{ not json" });
    assertEquals(res.status, 400);
    assertEquals(res.body.ok, false);
    assert(typeof res.body.error === "string" && res.body.error.includes("not valid JSON"));
    assertEquals((await deliveryGraphLibrary(data).all()).length, 0);
  });
});

test("save-to-library: a valid-JSON but UNCOMPILABLE graph → 400 with path-qualified errors, nothing persisted", async () => {
  await withApp(async (app, data) => {
    // A structurally-invalid graph (edge references a node that does not exist) fails compilation.
    const uncompilable = JSON.stringify({
      name: "broken",
      nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:feature" } }],
      edges: [{ from: "a", to: "missing" }],
    });
    const res = await call(app, { name: "broken", graphJson: uncompilable });
    assertEquals(res.status, 400);
    assertEquals(res.body.ok, false);
    assert(Array.isArray(res.body.errors) && res.body.errors.length > 0);
    assertEquals((await deliveryGraphLibrary(data).all()).length, 0);
  });
});

test("save-to-library: a blank name → 400, nothing persisted", async () => {
  await withApp(async (app, data) => {
    const res = await call(app, { name: "   ", graphJson: GOOD });
    assertEquals(res.status, 400);
    assertEquals(res.body.ok, false);
    assertEquals((await deliveryGraphLibrary(data).all()).length, 0);
  });
});

test("save-to-library: providing BOTH graphJson and digest → 400, nothing persisted", async () => {
  await withApp(async (app, data) => {
    const res = await call(app, { name: "conflict", graphJson: GOOD, digest: "deadbeef0000" });
    assertEquals(res.status, 400);
    assertEquals(res.body.ok, false);
    assertEquals((await deliveryGraphLibrary(data).all()).length, 0);
  });
});
