// Integration coverage for GET /app/api/delivery-graph/staged operation `listStagedProposals` (issue
// #511) — the read behind the Staged proposals App-View. It lists every LIVE staged delivery-graph
// proposal (not aged out of its TTL), newest first, projected to the Preview-DI + Dispatch metadata.
// These tests drive the REAL door through `bootTestApp`'s api driver: stage via the compile door, then
// list; assert the staged proposal appears with its counts, that dispatching drops it off the list, and
// that the `graph`/`preview` payloads are NOT leaked into the lean list projection.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";

const APP_ROOT = resolve(import.meta.dirname, "..");
const GITHUB_ENV: Record<string, string> = { NANO_PR_GITHUB_TRANSPORT: "token", GITHUB_TOKEN: "" };

const SIDE_EFFECTING = {
  name: "release runbook",
  nodes: [
    { id: "open-b", kind: "agent", agent: { jobType: "senior:demo", prompt: "un-draft + merge #B" } },
    { id: "cut", kind: "agent", agent: { jobType: "senior:demo", prompt: "cut the release" } },
  ],
  edges: [{ from: "open-b", to: "cut" }],
};

const WAIT_ONLY = {
  name: "soak only",
  nodes: [
    { id: "soak", kind: "wait", wait: { kind: "github-check", target: "owner/repo@main" } },
    { id: "done", kind: "human", human: { prompt: "Confirm the soak looked clean." } },
  ],
  edges: [{ from: "soak", to: "done" }],
};

interface StagedProposalSummary {
  digest: string;
  title: string | null;
  nodeCount: number;
  humanNodeCount: number;
  sideEffectCount: number;
  sideEffecting: boolean;
  createdAt: string;
  expiresAt: string;
}
type ListResponse = { count: number; proposals: StagedProposalSummary[] };

describe("listStagedProposals — the live staged-proposals list", () => {
  const dirs: string[] = [];
  const apps: TestApp[] = [];
  after(async () => {
    for (const app of apps) await app.stop?.();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const boot = async (): Promise<TestApp> => {
    const d = mkdtempSync(join(tmpdir(), "nwf-list-staged-"));
    dirs.push(d);
    const app = await bootTestApp(APP_ROOT, { env: { ...GITHUB_ENV, NANO_APP_DB_URL: `file:${join(d, "app.db")}` } });
    apps.push(app);
    return app;
  };

  test("no staged proposals → 200 with an empty list", async () => {
    const app = await boot();
    assert.ok(app.api);
    const res = await app.api.call<ListResponse>("listStagedProposals", {});
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 0);
    assert.deepEqual(res.body.proposals, []);
  });

  test("a staged graph appears with its projected counts; no graph/preview payload is leaked", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;
    const staged = await api.call<{ digest: string }>("compileDeliveryGraph", { body: SIDE_EFFECTING });
    const digest = staged.body.digest;

    const res = await api.call<ListResponse>("listStagedProposals", {});
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 1);
    const row = res.body.proposals[0];
    assert.equal(row.digest, digest);
    assert.equal(row.title, "release runbook");
    assert.equal(row.nodeCount, 2);
    assert.equal(row.humanNodeCount, 0);
    assert.equal(row.sideEffectCount, 2);
    assert.equal(row.sideEffecting, true);
    assert.ok(typeof row.createdAt === "string" && row.createdAt.length > 0);
    assert.ok(typeof row.expiresAt === "string" && row.expiresAt.length > 0);
    // The list is a lean projection — the heavy graph/preview JSON is NOT included (the App-View
    // recompiles by digest through previewProposalBpmn for the DI preview).
    assert.ok(!("graph" in row), "the list must not leak the stored graph JSON");
    assert.ok(!("preview" in row), "the list must not leak the stored preview JSON");
  });

  test("a wait/human-only graph is reported as not side-effecting", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;
    await api.call<{ digest: string }>("compileDeliveryGraph", { body: WAIT_ONLY });
    const res = await api.call<ListResponse>("listStagedProposals", {});
    assert.equal(res.body.count, 1);
    const row = res.body.proposals[0];
    assert.equal(row.sideEffecting, false);
    assert.equal(row.sideEffectCount, 0);
    assert.equal(row.humanNodeCount, 1);
  });

  test("dispatching a staged proposal drops it off the live list", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;
    const staged = await api.call<{ digest: string }>("compileDeliveryGraph", { body: SIDE_EFFECTING });
    const digest = staged.body.digest;
    assert.equal((await api.call<ListResponse>("listStagedProposals", {})).body.count, 1);

    const dispatched = await api.call<{ ok: boolean }>("dispatchDeliveryGraph", { body: { digest } });
    assert.equal(dispatched.body.ok, true);

    const after = await api.call<ListResponse>("listStagedProposals", {});
    assert.equal(after.body.count, 0, "a dispatched proposal is no longer staged");
  });
});
