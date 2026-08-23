// Integration coverage for POST /app/api/actions/delivery-graph/proposal-bpmn operation
// `previewProposalBpmn` — the READ-ONLY DI preview door. The cockpit posts a staged proposal's
// `digest`; this door recompiles that staged graph and returns the compiled BPMN (with DI) so the host
// explorer can render the generated diagram interchange BEFORE dispatch. It deploys nothing and
// launches nothing. These tests drive the REAL door through `bootTestApp`'s api driver: stage via the
// compile door, then preview by digest, asserting the BPMN carries DI and that an unknown/blank digest
// is refused cleanly.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";
import { deliveryGraphRuns } from "../app/deliveryGraphRun.ts";

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

describe("previewProposalBpmn — read-only DI preview of a staged proposal", () => {
  const dirs: string[] = [];
  const apps: TestApp[] = [];
  after(async () => {
    for (const app of apps) await app.stop?.();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const boot = async (): Promise<TestApp> => {
    const d = mkdtempSync(join(tmpdir(), "nwf-preview-bpmn-"));
    dirs.push(d);
    const app = await bootTestApp(APP_ROOT, { env: { ...GITHUB_ENV, NANO_APP_DB_URL: `file:${join(d, "app.db")}` } });
    apps.push(app);
    return app;
  };

  test("a missing/blank digest → 400 with a human error", async () => {
    const app = await boot();
    assert.ok(app.api);
    const res = await app.api.call<{ ok: boolean; error?: string }>("previewProposalBpmn", { body: { digest: "  " } });
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.ok(typeof res.body.error === "string" && res.body.error.length > 0);
  });

  test("an unknown / never-staged digest → 400", async () => {
    const app = await boot();
    assert.ok(app.api);
    const res = await app.api.call<{ ok: boolean; error?: string }>("previewProposalBpmn", { body: { digest: "deadbeef0000" } });
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.ok(/no staged proposal/.test(res.body.error ?? ""));
  });

  test("a staged graph: preview by digest → 200 with BPMN carrying DI; nothing deployed or launched", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;

    const staged = await api.call<{ digest: string }>("compileDeliveryGraph", { body: SIDE_EFFECTING });
    assert.equal(staged.status, 200);
    const digest = staged.body.digest;

    const res = await api.call<{ ok: boolean; digest?: string; bpmn?: string }>("previewProposalBpmn", { body: { digest } });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.digest, digest);
    const bpmn = res.body.bpmn ?? "";
    // The returned BPMN carries diagram interchange (this is the whole point — a renderable DI).
    assert.ok(bpmn.includes("<bpmndi:BPMNDiagram"), "BPMN must include diagram interchange");
    assert.ok(bpmn.includes("bpmn:definitions") || bpmn.includes("<definitions"), "BPMN must be a definitions doc");
    // Pure read: no run was launched.
    await app.settle();
    assert.equal((await deliveryGraphRuns(app.db).all()).length, 0);
  });

  test("preview is deterministic — the same digest returns byte-identical BPMN across calls", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;
    const staged = await api.call<{ digest: string }>("compileDeliveryGraph", { body: SIDE_EFFECTING });
    const digest = staged.body.digest;
    const a = await api.call<{ bpmn?: string }>("previewProposalBpmn", { body: { digest } });
    const b = await api.call<{ bpmn?: string }>("previewProposalBpmn", { body: { digest } });
    assert.equal(a.body.bpmn, b.body.bpmn);
  });
});
