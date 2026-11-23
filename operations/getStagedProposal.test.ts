// Integration coverage for GET /app/api/delivery-graph/staged/{digest} → `getStagedProposal`
// (issue #989, `d8ctl nwf graph show`): stage via the compile door, then read the per-step summary an
// operator reviews before dispatch — kind/type, target, dependencies, guard, time limit, on-timeout,
// converge / auto-merge — without grepping the compiled BPMN.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";

const APP_ROOT = resolve(import.meta.dirname, "..");
const GITHUB_ENV: Record<string, string> = { NANO_PR_GITHUB_TRANSPORT: "token", GITHUB_TOKEN: "" };

const GRAPH = {
  name: "ship B after epic",
  nodes: [
    { id: "gate", kind: "wait", wait: { kind: "epic", target: "owner/repo#488", poll: { timeoutMs: 259_200_000 } } },
    { id: "build", kind: "agent", agent: { jobType: "senior:feature", repository: "owner/repo", converge: true, merge: true }, emits: [{ name: "pr", type: "pr" }] },
    // #1031: an edge out of a `merge: true` agent must pass a merged-PR gate.
    { id: "landed", kind: "wait", wait: { kind: "pr", target: "build.pr", match: { prState: "merged" } } },
    { id: "ok", kind: "human", human: { prompt: "Confirm." } },
  ],
  edges: [
    { from: "gate", to: "build" },
    { from: "build.pr", to: "landed" },
    { from: "landed", to: "ok" },
  ],
};

interface Step {
  id: string;
  kind: string;
  type: string;
  target: string | null;
  dependsOn: string[];
  gate: string | null;
  timeLimit: string | null;
  timeLimitDefaulted: boolean;
  onTimeout: string | null;
  converge: boolean;
  autoMerge: boolean;
}

describe("getStagedProposal — per-step summary of a staged graph", () => {
  const dirs: string[] = [];
  const apps: TestApp[] = [];
  after(async () => {
    for (const app of apps) await app.stop?.();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const boot = async (): Promise<TestApp> => {
    const d = mkdtempSync(join(tmpdir(), "nwf-show-staged-"));
    dirs.push(d);
    const app = await bootTestApp(APP_ROOT, { env: { ...GITHUB_ENV, NANO_APP_DB_URL: `file:${join(d, "app.db")}` } });
    apps.push(app);
    return app;
  };

  test("lists each step with type, target, dependencies, time limit and merge settings", async () => {
    const app = await boot();
    assert.ok(app.api);
    const staged = await app.api.call<{ digest: string }>("compileDeliveryGraph", { body: GRAPH });
    const res = await app.api.call<{ digest: string; steps: Step[] }>("getStagedProposal", {
      params: { digest: staged.body.digest },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.digest, staged.body.digest);
    const byId = new Map(res.body.steps.map((s) => [s.id, s]));
    const gate = byId.get("gate");
    assert.equal(gate?.type, "wait:epic");
    assert.equal(gate?.target, "owner/repo#488");
    assert.equal(gate?.timeLimit, "PT259200S"); // 72h, as the engine timer reads it
    assert.equal(gate?.timeLimitDefaulted, false);
    assert.equal(gate?.onTimeout, "escalate");
    const build = byId.get("build");
    assert.equal(build?.type, "senior:feature");
    assert.deepEqual(build?.dependsOn, ["gate"]);
    assert.equal(build?.converge, true);
    assert.equal(build?.autoMerge, true);
    assert.equal(build?.timeLimitDefaulted, true);
    assert.equal(byId.get("ok")?.kind, "human");
  });

  test("an unknown digest is a 404", async () => {
    const app = await boot();
    assert.ok(app.api);
    const res = await app.api.call("getStagedProposal", { params: { digest: "nope" } });
    assert.equal(res.status, 404);
  });
});
