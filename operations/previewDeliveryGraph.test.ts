// Tests for the POST /app/api/actions/delivery-graph/preview operation `previewDeliveryGraph` (ADR
// 0005 Decision 7, issue #460) — the human-facing UI JSON-paste PREVIEW+STAGE ingress. It parses the
// operator's pasted JSON STRING, runs the SAME `compileDeliveryGraph` compiler the agent door uses,
// and — like the agent compile door — persists the compiled graph as a `staged` proposal, returning a
// compact summary (200, `staged:true` + `reviewUrl`) or a human `error` + path-qualified `errors`
// (400). It never dispatches — that is a separate operator action on the staged proposal.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi, DataLayer } from "@nanobpm/urban";
import { bootTestApp } from "@nanobpm/urban-testkit";
import { deliveryGraphProposals } from "../app/deliveryGraphProposals.ts";
import { noopLog } from "../test/log.ts";
import handler from "./previewDeliveryGraph.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");

async function withApp(fn: (app: AppApi, data: DataLayer) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-dgpreview-"));
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

test("preview-delivery-graph: a pasted well-formed graph → 200 summary, staged, with digest + counts", async () => {
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
    assert(typeof res.body.diagram === "string" && res.body.diagram.length > 0);
    assertEquals(res.body.title, "runbook");
    // The FULL preview detail (#441) — the human stop-points and side-effecting actions the page
    // renders, not just the counts. `a` is the side-effecting agent node; `b` is the human stop.
    assert(Array.isArray(res.body.humanNodes) && res.body.humanNodes.length === 1);
    assertEquals(res.body.humanNodes[0].nodeId, "b");
    assertEquals(res.body.humanNodes[0].prompt, "do X");
    assert(Array.isArray(res.body.sideEffects) && res.body.sideEffects.length === 1);
    assertEquals(res.body.sideEffects[0].nodeId, "a");
    assertEquals(res.body.sideEffects[0].kind, "agent");
    assert(typeof res.body.sideEffects[0].description === "string" && res.body.sideEffects[0].description.length > 0);
    // A staged proposal now exists for the operator to dispatch — and NO dispatch handle came back.
    assertEquals((await deliveryGraphProposals(data).get(res.body.digest))?.status, "staged");
    assertEquals(res.body.runKey, undefined);
    assertEquals(res.body.processInstanceKey, undefined);
  });
});

test("preview-delivery-graph: repeated previews stage the identical digest idempotently (one live row)", async () => {
  await withApp(async (app, data) => {
    const a = await call(app, { graphJson: GOOD });
    const b = await call(app, { graphJson: GOOD });
    assertEquals(a.body.digest, b.body.digest);
    assertEquals((await deliveryGraphProposals(data).find({ digest: a.body.digest })).length, 1);
  });
});

test("preview-delivery-graph: text that is not valid JSON → 400 with a human error, nothing staged", async () => {
  await withApp(async (app, data) => {
    const res = await call(app, { graphJson: "{ not json" });
    assertEquals(res.status, 400);
    assertEquals(res.body.ok, false);
    assert(typeof res.body.error === "string" && res.body.error.includes("not valid JSON"));
    assertEquals((await deliveryGraphProposals(data).all()).length, 0);
  });
});

test("preview-delivery-graph: a blank paste → 400, never a 500", async () => {
  await withApp(async (app) => {
    const res = await call(app, { graphJson: "   " });
    assertEquals(res.status, 400);
    assertEquals(res.body.ok, false);
    assert(typeof res.body.error === "string" && res.body.error.length > 0);
  });
});

test("preview-delivery-graph: a valid-JSON but malformed graph → 400 with path-qualified errors, nothing staged", async () => {
  await withApp(async (app, data) => {
    const res = await call(app, {
      graphJson: JSON.stringify({ nodes: [{ id: "a", kind: "agent", agent: { jobType: "j" } }], edges: [{ from: "a", to: "ghost" }] }),
    });
    assertEquals(res.status, 400);
    assertEquals(res.body.ok, false);
    assert(Array.isArray(res.body.errors) && res.body.errors.length > 0);
    assert(res.body.errors.every((e: { path: string; message: string }) => typeof e.path === "string"));
    assertEquals((await deliveryGraphProposals(data).all()).length, 0);
  });
});

test("preview-delivery-graph: a pasted JSON array (not an object) → 400", async () => {
  await withApp(async (app) => {
    const res = await call(app, { graphJson: "[]" });
    assertEquals(res.status, 400);
    assertEquals(res.body.ok, false);
  });
});
