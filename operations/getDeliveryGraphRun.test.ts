// Integration coverage for GET /app/api/delivery-graph/runs/{runKey} → `getDeliveryGraphRun`
// (issue #1055, `d8ctl nwf graph progress`): an unknown run is a 404; a known run resolves its nodes
// from the dispatched (stored) graph, and before launch every node is `pending`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";
import { buildDeliveryGraphRunRow, deliveryGraphRuns } from "../app/deliveryGraphRun.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");
const GITHUB_ENV: Record<string, string> = { NANO_PR_GITHUB_TRANSPORT: "token", GITHUB_TOKEN: "" };

const GRAPH = {
  name: "progress probe",
  nodes: [
    { id: "gate", kind: "wait", wait: { kind: "pr", target: "owner/repo#1", match: { prState: "merged" } } },
    { id: "ok", kind: "human", human: { prompt: "Confirm." } },
  ],
  edges: [{ from: "gate", to: "ok" }],
};

interface Progress {
  runKey: string;
  status: string;
  nodes: { id: string; kind: string; state: string; dependsOn: string[] }[];
  mermaid: string | null;
  note: string | null;
}

describe("getDeliveryGraphRun — per-node progress", () => {
  const dirs: string[] = [];
  const apps: TestApp[] = [];
  after(async () => {
    for (const app of apps) await app.stop?.();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const boot = async (): Promise<TestApp> => {
    const d = mkdtempSync(join(tmpdir(), "nwf-graph-progress-"));
    dirs.push(d);
    const app = await bootTestApp(APP_ROOT, { env: { ...GITHUB_ENV, NANO_APP_DB_URL: `file:${join(d, "app.db")}` } });
    apps.push(app);
    return app;
  };

  test("an unknown run key is a 404", async () => {
    const app = await boot();
    assert.ok(app.api);
    const res = await app.api.call("getDeliveryGraphRun", { params: { runKey: "nope" } });
    assert.equal(res.status, 404);
  });

  test("a run not yet launched lists every node of its graph as pending", async () => {
    const app = await boot();
    assert.ok(app.api);
    const staged = await app.api.call<{ digest: string }>("compileDeliveryGraph", { body: GRAPH });
    await deliveryGraphRuns(app.db).insert(
      buildDeliveryGraphRunRow({
        runKey: "run-1",
        digest: staged.body.digest,
        status: "awaiting-approval",
        sideEffecting: false,
        nodeCount: 2,
        humanNodeCount: 1,
        sideEffectCount: 0,
        title: "progress probe",
        phase: "Awaiting approval",
      }),
    );
    const res = await app.api.call<Progress>("getDeliveryGraphRun", { params: { runKey: "run-1" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.runKey, "run-1");
    assert.equal(res.body.note, null);
    const by = new Map(res.body.nodes.map((n) => [n.id, n]));
    assert.equal(by.get("gate")?.state, "pending");
    assert.equal(by.get("ok")?.kind, "human");
    assert.deepEqual(by.get("ok")?.dependsOn, ["gate"]);
    assert.match(res.body.mermaid ?? "", /class \S+ pending/);
  });
});
