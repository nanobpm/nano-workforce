// Tests for the POST /app/api/actions/start/sequence-issues operation `sequenceIssues` (epic
// nano-workforce#605, S4/#610). The intent-shaped door GENERATES the canonical delivery graph and
// STAGES it through the SAME compile+stage flow as `compileDeliveryGraph` — the response carries only
// a preview + a navigational `reviewUrl` (no dispatch handle); dispatch stays an operator action.
// Invalid input is a 400 with `issues[{path,message}]` and nothing is staged.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi, DataLayer } from "@nanobpm/urban";
import { bootTestApp } from "@nanobpm/urban-testkit";
import { deliveryGraphProposals, listStagedProposals } from "../app/deliveryGraphProposals.ts";
import { noopLog } from "../test/log.ts";
import handler from "./sequenceIssues.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");

async function withApp(fn: (app: AppApi, data: DataLayer) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-seqissues-"));
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
  const req = { path: "/app/api/actions/start/sequence-issues", headers: new Headers(headers) };
  return (await handler({ req: req as any, params: {}, query: {}, body } as any, app)) as any;
}

test("sequence-issues: a valid intent → 200 ready, staged as a proposal, with the preview", async () => {
  await withApp(async (app, data) => {
    const res = await call(app, { behind: "acme/repo#100", issues: ["acme/repo#1", "acme/repo#2"] });
    assertEquals(res.status, 200);
    assertEquals(res.body.status, "ready");
    assert(typeof res.body.digest === "string" && res.body.digest.length > 0);
    assert(typeof res.body.preview === "object" && res.body.preview !== null);
    assert(typeof res.body.preview.diagram === "string" && res.body.preview.diagram.length > 0);
    // Staged through the SAME path as compileDeliveryGraph — visible immediately (read-after-write).
    const row = await deliveryGraphProposals(data).get(res.body.digest);
    assert(row, "the generated graph is staged for operator dispatch");
    assertEquals(row?.status, "staged");
    const live = await listStagedProposals(data);
    assert(live.some((p) => p.digest === res.body.digest), "the staged digest is listed");
  });
});

test("sequence-issues: the response exposes NO dispatch handle — the door stages, never dispatches", async () => {
  await withApp(async (app) => {
    const res = await call(app, { issues: ["acme/repo#1"] });
    assertEquals(res.status, 200);
    const keys = Object.keys(res.body);
    for (const forbidden of ["runKey", "token", "approvalToken", "processInstanceKey", "processKey", "dispatchUrl"]) {
      assert(!keys.includes(forbidden), `response must not carry a dispatch handle (${forbidden})`);
    }
  });
});

test("sequence-issues: an identical intent re-stages the SAME digest (idempotent), not a duplicate", async () => {
  await withApp(async (app, data) => {
    const a = await call(app, { issues: ["acme/repo#1", "acme/repo#2"] });
    const b = await call(app, { issues: ["acme/repo#1", "acme/repo#2"] });
    assertEquals(a.body.digest, b.body.digest);
    const live = await listStagedProposals(data);
    assertEquals(live.filter((p) => p.digest === a.body.digest).length, 1);
  });
});

test("sequence-issues: empty issues → 400 with issues[{path,message}], nothing staged", async () => {
  await withApp(async (app, data) => {
    const res = await call(app, { issues: [] });
    assertEquals(res.status, 400);
    assert(Array.isArray(res.body.issues) && res.body.issues.length > 0);
    for (const iss of res.body.issues) {
      assert(typeof iss.path === "string" && typeof iss.message === "string");
    }
    assertEquals((await listStagedProposals(data)).length, 0);
  });
});

test("sequence-issues: an unparseable issue ref → 400 at the offending path, nothing staged", async () => {
  await withApp(async (app, data) => {
    const res = await call(app, { issues: ["acme/repo#1", "garbage"] });
    assertEquals(res.status, 400);
    assert(res.body.issues.some((i: any) => i.path === "issues[1]"));
    assertEquals((await listStagedProposals(data)).length, 0);
  });
});

test("sequence-issues: a missing body folds into the same 400 contract (not a 500)", async () => {
  await withApp(async (app) => {
    const res = await call(app, undefined);
    assertEquals(res.status, 400);
    assert(Array.isArray(res.body.issues) && res.body.issues.length > 0);
  });
});
