// Integration coverage for the POST /app/api/actions/delivery-graph/dismiss operation `dismissProposal`
// (#520) — the OPERATOR-ONLY dismiss door. The cockpit's staged-proposals grid posts the `digest` of the
// proposal the operator wants to discard as noise; this door loads that live `staged` proposal and flips
// it to the terminal `dismissed` status, so it drops out of the staged list — exactly like
// `superseded`/`expired`, but recording a deliberate operator discard. It launches nothing. These tests
// drive the REAL door through `bootTestApp`'s api driver against the WASM engine: compile-to-stage, then
// dismiss by digest, asserting the row leaves the staged list, an unknown digest is refused, and a
// re-dismiss of an already-dismissed digest is idempotently refused (nothing changes, nothing launches).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";
import { deliveryGraphProposals, listStagedProposals } from "../app/deliveryGraphProposals.ts";
import { deliveryGraphRuns } from "../app/deliveryGraphRun.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");
const GITHUB_ENV: Record<string, string> = { NANO_PR_GITHUB_TRANSPORT: "token", GITHUB_TOKEN: "" };

const HUMAN_ONLY = {
  name: "manual gate",
  nodes: [{ id: "ack", kind: "human", human: { prompt: "click done when the release is out" } }],
};

describe("dismissProposal — operator dismiss of a staged-proposal by digest", () => {
  const dirs: string[] = [];
  const apps: TestApp[] = [];
  after(async () => {
    for (const app of apps) await app.stop?.();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const boot = async (): Promise<TestApp> => {
    const d = mkdtempSync(join(tmpdir(), "nwf-dismiss-"));
    dirs.push(d);
    const app = await bootTestApp(APP_ROOT, { env: { ...GITHUB_ENV, NANO_APP_DB_URL: `file:${join(d, "app.db")}` } });
    apps.push(app);
    return app;
  };

  test("a missing/blank digest → 400 with a human error, nothing changed", async () => {
    const app = await boot();
    assert.ok(app.api);
    const res = await app.api.call<{ ok: boolean; error?: string }>("dismissProposal", { body: { digest: "  " } });
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.ok(typeof res.body.error === "string" && res.body.error.length > 0);
  });

  test("an unknown / never-staged digest → 400, nothing changed", async () => {
    const app = await boot();
    assert.ok(app.api);
    const res = await app.api.call<{ ok: boolean; error?: string }>("dismissProposal", { body: { digest: "deadbeef0000" } });
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.ok(/no staged proposal/.test(res.body.error ?? ""));
  });

  test("dismiss a staged proposal by digest → 200; the row leaves the staged list; nothing launches", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;

    // Stage through the agent compile door — it returns a preview + digest and stages the proposal.
    const staged = await api.call<{ status: string; digest: string }>("compileDeliveryGraph", { body: HUMAN_ONLY });
    assert.equal(staged.status, 200);
    const digest = staged.body.digest;
    assert.equal((await deliveryGraphProposals(app.db).get(digest))?.status, "staged");
    assert.equal((await listStagedProposals(app.db)).length, 1);

    // The operator dismisses that digest.
    const res = await api.call<{ ok: boolean; digest?: string }>("dismissProposal", { body: { digest } });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.digest, digest);

    // The proposal drops out of the staged list — it is now terminal (`dismissed`).
    assert.equal((await deliveryGraphProposals(app.db).get(digest))?.status, "dismissed");
    assert.equal((await listStagedProposals(app.db)).length, 0);
    // Dismiss launches nothing — no runs exist.
    await app.settle();
    assert.equal((await deliveryGraphRuns(app.db).all()).length, 0);
  });

  test("re-dismissing an ALREADY-dismissed digest is idempotent → 400, state unchanged", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;
    const staged = await api.call<{ digest: string }>("compileDeliveryGraph", { body: HUMAN_ONLY });
    const digest = staged.body.digest;

    const first = await api.call<{ ok: boolean }>("dismissProposal", { body: { digest } });
    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);
    assert.equal((await deliveryGraphProposals(app.db).get(digest))?.status, "dismissed");

    // A second dismiss finds no LIVE staged proposal → clean 400; the row stays `dismissed` (unchanged).
    const again = await api.call<{ ok: boolean; error?: string }>("dismissProposal", { body: { digest } });
    assert.equal(again.status, 400);
    assert.equal(again.body.ok, false);
    assert.ok(/no staged proposal/.test(again.body.error ?? ""));
    assert.equal((await deliveryGraphProposals(app.db).get(digest))?.status, "dismissed");
  });
});
