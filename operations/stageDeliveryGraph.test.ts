// Tests for the POST /app/api/actions/delivery-graph/stage operation `stageDeliveryGraph` (ADR 0005
// Decision 7, issues #460 + #516) — the STAGE half of the preview/stage split. It parses the
// operator's pasted JSON STRING, runs the SAME compiler the preview/agent doors use, and — on success
// — persists the compiled graph as a `staged` proposal (200, `staged:true`). Unlike the pure preview
// door it PERSISTS; unlike dispatch it never launches (no run key / instance key comes back).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi, DataLayer } from "@nanobpm/urban";
import { bootTestApp } from "@nanobpm/urban-testkit";
import { deliveryGraphProposals } from "../app/deliveryGraphProposals.ts";
import { noopLog } from "../test/log.ts";
import handler from "./stageDeliveryGraph.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");

async function withApp(fn: (app: AppApi, data: DataLayer) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-dgstage-"));
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
  name: "runbook",
  nodes: [
    { id: "a", kind: "agent", agent: { jobType: "senior:feature" } },
    { id: "b", kind: "human", human: { prompt: "do X" } },
  ],
  edges: [{ from: "a", to: "b" }],
});

test("stage-delivery-graph: a pasted well-formed graph → 200, staged, with digest + counts", async () => {
  await withApp(async (app, data) => {
    const res = await call(app, { graphJson: GOOD });
    assertEquals(res.status, 200);
    assertEquals(res.body.ok, true);
    assertEquals(res.body.staged, true);
    assert(typeof res.body.digest === "string" && res.body.digest.length > 0);
    assert(typeof res.body.reviewUrl === "string" && res.body.reviewUrl.length > 0);
    assertEquals(res.body.nodeCount, 2);
    assertEquals(res.body.humanNodeCount, 1);
    assertEquals(res.body.sideEffectCount, 1);
    assertEquals(res.body.sideEffecting, true);
    assertEquals(res.body.title, "runbook");
    // Full preview detail is still returned so the page renders the same summary as preview.
    assert(Array.isArray(res.body.humanNodes) && res.body.humanNodes.length === 1);
    assert(Array.isArray(res.body.sideEffects) && res.body.sideEffects.length === 1);
    // The stage door persists a `staged` proposal — and returns NO dispatch handle (#460).
    assertEquals((await deliveryGraphProposals(data).get(res.body.digest))?.status, "staged");
    assertEquals(res.body.runKey, undefined);
    assertEquals(res.body.processInstanceKey, undefined);
    // The stage summary omits the heavy BPMN (the staged grid recompiles by digest for its DI preview).
    assertEquals(res.body.bpmn, undefined);
  });
});

test("stage-delivery-graph: repeated stages of the same graph → one live row (idempotent on digest)", async () => {
  await withApp(async (app, data) => {
    const a = await call(app, { graphJson: GOOD });
    const b = await call(app, { graphJson: GOOD });
    assertEquals(a.body.digest, b.body.digest);
    assertEquals((await deliveryGraphProposals(data).find({ digest: a.body.digest })).length, 1);
  });
});

test("stage-delivery-graph: text that is not valid JSON → 400, nothing staged", async () => {
  await withApp(async (app, data) => {
    const res = await call(app, { graphJson: "{ not json" });
    assertEquals(res.status, 400);
    assertEquals(res.body.ok, false);
    assert(typeof res.body.error === "string" && res.body.error.includes("not valid JSON"));
    assertEquals((await deliveryGraphProposals(data).all()).length, 0);
  });
});

test("stage-delivery-graph: a valid-JSON but malformed graph → 400 with path-qualified errors, nothing staged", async () => {
  await withApp(async (app, data) => {
    const res = await call(app, {
      graphJson: JSON.stringify({ nodes: [{ id: "a", kind: "agent", agent: { jobType: "j" } }], edges: [{ from: "a", to: "ghost" }] }),
    });
    assertEquals(res.status, 400);
    assertEquals(res.body.ok, false);
    assert(Array.isArray(res.body.errors) && res.body.errors.length > 0);
    assertEquals((await deliveryGraphProposals(data).all()).length, 0);
  });
});

test("stage-delivery-graph: a blank paste → 400, never a 500", async () => {
  await withApp(async (app) => {
    const res = await call(app, { graphJson: "   " });
    assertEquals(res.status, 400);
    assertEquals(res.body.ok, false);
  });
});
