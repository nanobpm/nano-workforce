// Tests for the POST /app/api/actions/compile-delivery-graph operation `compileDeliveryGraph` (ADR
// 0005 Decision 7, issue #460). This is the END of the agent's surface: a well-formed graph compiles
// and is PERSISTED as a `staged` proposal, and the response carries only a preview + a navigational
// `reviewUrl` — never a run key, token, or process-instance key. A malformed graph is a 400 with
// path-qualified errors and nothing is staged. The Red/Green guard here is that the response exposes
// NO dispatch handle, closing the self-approval hole the old replayable `approvalToken` left open.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi, DataLayer } from "@nanobpm/urban";
import { bootTestApp } from "@nanobpm/urban-testkit";
import { deliveryGraphProposals } from "../app/deliveryGraphProposals.ts";
import { noopLog } from "../test/log.ts";
import handler from "./compileDeliveryGraph.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");

/** Boot an app purely for its provisioned data layer (migration 075 applied), run `fn`, tear down. */
async function withApp(fn: (app: AppApi, data: DataLayer) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-dgcompile-"));
  const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dir, "app.db")}` } });
  try {
    const edge = { data: app.db, log: noopLog() } as unknown as AppApi;
    await fn(edge, app.db);
  } finally {
    await app.stop?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function call(app: AppApi, body: unknown, headers: Record<string, string> = {}) {
  const req = { path: "/app/api/actions/compile-delivery-graph", headers: new Headers(headers) };
  return (await handler({ req: req as any, params: {}, query: {}, body } as any, app)) as any;
}

const GOOD = {
  name: "runbook",
  nodes: [
    { id: "a", kind: "agent", agent: { jobType: "senior:feature" } },
    { id: "b", kind: "human", human: { prompt: "do X" } },
  ],
  edges: [{ from: "a", to: "b" }],
};

test("compile-delivery-graph: a well-formed graph → 200 ready, staged as a proposal, with the preview", async () => {
  await withApp(async (app, data) => {
    const res = await call(app, GOOD);
    assertEquals(res.status, 200);
    assertEquals(res.body.status, "ready");
    assert(typeof res.body.message === "string" && res.body.message.length > 0);
    assert(typeof res.body.digest === "string" && res.body.digest.length > 0);
    assert(typeof res.body.preview === "object" && res.body.preview !== null);
    assert(typeof res.body.preview.diagram === "string" && res.body.preview.diagram.length > 0);
    assertEquals(res.body.preview.humanNodes.length, 1);
    // The compiled graph was persisted as a staged proposal keyed by its content digest.
    const row = await deliveryGraphProposals(data).get(res.body.digest);
    assert(row, "the compiled graph is staged for operator dispatch");
    assertEquals(row?.status, "staged");
    assertEquals(row?.logical_key, "runbook");
  });
});

// ── Red/Green: the agent surface hands back NO dispatch handle (issue #460) ────
test("compile-delivery-graph: the response exposes NO dispatch handle — no runKey, token, or process key to replay", async () => {
  await withApp(async (app) => {
    const res = await call(app, GOOD);
    assertEquals(res.status, 200);
    // The self-approval hole is closed by ABSENCE: there is nothing in the response a caller can
    // replay to start a run. A regression that re-adds any of these fields fails here (Red/Green).
    assertEquals(res.body.runKey, undefined);
    assertEquals(res.body.approvalToken, undefined);
    assertEquals(res.body.processInstanceKey, undefined);
    assertEquals(res.body.processDefinitionId, undefined);
    assertEquals(res.body.alreadyRunning, undefined);
    // `reviewUrl` is navigational only — it points at the cockpit page, not an API dispatch endpoint.
    assert(typeof res.body.reviewUrl === "string");
    assert(!/\/actions\/start\/delivery-graph/.test(res.body.reviewUrl), "reviewUrl is not a dispatch endpoint");
  });
});

// ── #577: reviewUrl is a caller-facing link → keyed to the request origin, not the static base ──
test("compile-delivery-graph: reviewUrl is on the request's forwarded origin, not NANO_WORKFORCE_BASE_URL", async () => {
  await withApp(async (app) => {
    const res = await call(app, GOOD, { "x-forwarded-proto": "https", "x-forwarded-host": "example.test" });
    assertEquals(res.status, 200);
    assertEquals(
      res.body.reviewUrl,
      `https://example.test/app/pages/delivery-graphs#proposal-${res.body.digest}`,
    );
  });
});

test("compile-delivery-graph: reviewUrl honours the reverse-proxy x-forwarded-prefix", async () => {
  await withApp(async (app) => {
    const res = await call(app, GOOD, {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "nano.ngrok-free.dev",
      "x-forwarded-prefix": "/console/app-view/Workforce",
    });
    assertEquals(res.status, 200);
    assertEquals(
      res.body.reviewUrl,
      `https://nano.ngrok-free.dev/console/app-view/Workforce/app/pages/delivery-graphs#proposal-${res.body.digest}`,
    );
  });
});

test("compile-delivery-graph: re-compiling the same graph is idempotent — one staged proposal, TTL anchored to the first stage", async () => {
  await withApp(async (app, data) => {
    const first = await call(app, GOOD);
    const firstRow = await deliveryGraphProposals(data).get(first.body.digest);
    await new Promise((r) => setTimeout(r, 5));
    const second = await call(app, GOOD);
    assertEquals(second.body.digest, first.body.digest);
    const rows = await deliveryGraphProposals(data).find({ digest: first.body.digest });
    assertEquals(rows.length, 1);
    assertEquals(rows[0].created_at, firstRow?.created_at); // TTL anchor preserved across re-stage
  });
});

test("compile-delivery-graph: a changed graph with the same name SUPERSEDES the prior staged proposal", async () => {
  await withApp(async (app, data) => {
    const a = await call(app, GOOD);
    const b = await call(app, { ...GOOD, nodes: [...GOOD.nodes, { id: "c", kind: "human", human: { prompt: "do Y" } }], edges: [...GOOD.edges, { from: "b", to: "c" }] });
    assert(a.body.digest !== b.body.digest, "the changed graph has a new digest");
    assertEquals((await deliveryGraphProposals(data).get(a.body.digest))?.status, "superseded");
    assertEquals((await deliveryGraphProposals(data).get(b.body.digest))?.status, "staged");
  });
});

test("compile-delivery-graph: a malformed graph → 400 with path-qualified errors, nothing staged", async () => {
  await withApp(async (app, data) => {
    const res = await call(app, {
      nodes: [{ id: "a", kind: "agent", agent: { jobType: "j" } }],
      edges: [{ from: "a", to: "ghost" }],
    });
    assertEquals(res.status, 400);
    assertEquals(res.body.ok, false);
    assert(Array.isArray(res.body.errors) && res.body.errors.length > 0);
    assert(res.body.errors.every((e: { path: string; message: string }) => typeof e.path === "string"));
    assertEquals((await deliveryGraphProposals(data).all()).length, 0);
  });
});

test("compile-delivery-graph: a missing/empty body → 400, never a 500, nothing staged", async () => {
  await withApp(async (app, data) => {
    const res = await call(app, undefined);
    assertEquals(res.status, 400);
    assertEquals(res.body.ok, false);
    assertEquals((await deliveryGraphProposals(data).all()).length, 0);
  });
});
