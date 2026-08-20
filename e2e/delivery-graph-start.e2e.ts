// End-to-end proof of the S5 DISPATCH DOOR (ADR 0005 Decision 7) driven through its REAL ingress — the
// `startDeliveryGraph` OpenAPI operation (`POST /app/api/actions/start/delivery-graph`), the one
// contract all three ingress paths (agent POST, raw REST, UI JSON-paste) share. Hermetic: deterministic
// virtual clock, no network. It proves the acceptance the slice hinges on:
//
//   • APPROVAL GATE: a side-effecting graph submitted WITHOUT approval is refused + PARKED (400,
//     awaiting-approval, no engine instance, no agent job fired) — and is VISIBLE in the cockpit's
//     `delivery_graph_runs` aggregate so an operator can see it waiting.
//   • DISPATCH: re-submitting the same graph WITH its content-addressed approval token dispatches — the
//     graph deploys + runs engine-natively (the agent side effect fires), and the run's derived phase
//     shows WHERE it is parked ("Parked on human node: …") via the same `pollDeliveryGraphPhase`
//     projection the cockpit reads.
//   • IDEMPOTENCY: a duplicate submit short-circuits (`alreadyRunning`) — the agent side effect fires
//     exactly ONCE, never twice.
//   • COMPLETION: when the instance ends, the poller reconciles the run to `done` (instanceTracking's
//     onTerminated reconciles only TERMINATED, so this poller owns COMPLETED→done).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";
import { deliveryGraphRuns } from "../app/deliveryGraphRun.ts";
import { pollDeliveryGraphPhase } from "../app/service.ts";
import type { DeliveryGraph } from "../nano-generated/api-io.d.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");
const GITHUB_ENV: Record<string, string> = { NANO_PR_GITHUB_TRANSPORT: "token", GITHUB_TOKEN: "" };

interface StartResult {
  ok: boolean;
  status: string;
  runKey: string;
  digest: string;
  sideEffecting: boolean;
  alreadyRunning?: boolean;
  processInstanceKey?: string;
  approvalToken?: string;
}

// A side-effecting graph: an `agent` side effect gated ahead of a `human` stop. Approval is required
// (the agent + the human-facing merge/publish class of graphs Decision 7 protects).
const GRAPH: DeliveryGraph = {
  name: "release runbook e2e",
  nodes: [
    { id: "open", kind: "agent", agent: { jobType: "senior:demo", prompt: "open + prep" } },
    { id: "publish", kind: "human", human: { prompt: "run the manual OTP publish" } },
  ],
  edges: [{ from: "open", to: "publish" }],
};

describe("startDeliveryGraph dispatch door — submit → approve → dispatch, idempotent (S5)", () => {
  const dirs: string[] = [];
  const apps: TestApp[] = [];
  after(async () => {
    for (const app of apps) await app.stop?.();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const boot = async (): Promise<TestApp> => {
    const d = mkdtempSync(join(tmpdir(), "nwf-delivery-start-e2e-"));
    dirs.push(d);
    const app = await bootTestApp(APP_ROOT, { env: { ...GITHUB_ENV, NANO_APP_DB_URL: `file:${join(d, "app.db")}` } });
    apps.push(app);
    return app;
  };

  test("a side-effecting graph is parked at approval, then dispatches once approved; a duplicate never double-launches", async () => {
    const app = await boot();
    assert.ok(app.api, "app declares an `api` binding");
    const api = app.api;

    let agentFired = 0;
    await app.engine.registerWorker("senior:demo", async () => {
      agentFired++;
      return {};
    });

    // ── Approval gate: submit WITHOUT approval → refused + parked, nothing launched ────────────────
    const parked = await api.call<StartResult>("startDeliveryGraph", { body: { graph: GRAPH } });
    assert.equal(parked.status, 400, "an unapproved side-effecting graph is refused");
    assert.equal(parked.body.status, "awaiting-approval");
    assert.equal(parked.body.sideEffecting, true);
    assert.ok(parked.body.approvalToken, "the response hands back the approval token to re-submit with");
    await app.settle();
    assert.equal(agentFired, 0, "a parked graph never dispatched its side effect");

    // The parked run is durable + visible in the cockpit aggregate.
    const runKey = parked.body.runKey;
    const parkedRow = await deliveryGraphRuns(app.db).get(runKey);
    assert.ok(parkedRow, "a delivery_graph_runs row exists for the parked graph");
    assert.equal(parkedRow?.status, "awaiting-approval");
    assert.equal(parkedRow?.process_key, null, "no engine instance while parked");

    // ── Dispatch: re-submit WITH the token → deploys + runs engine-natively ───────────────────────
    const token = parked.body.approvalToken;
    const dispatched = await api.call<StartResult>("startDeliveryGraph", { body: { graph: GRAPH, approvalToken: token } });
    assert.equal(dispatched.status, 202, "an approved graph dispatches");
    assert.equal(dispatched.body.status, "running");
    assert.equal(dispatched.body.alreadyRunning, false);
    assert.ok(dispatched.body.processInstanceKey, "the run carries the started engine instance key");
    await app.settle();
    assert.equal(agentFired, 1, "the agent side effect fired exactly once");

    // The run transitioned parked → running IN PLACE (one row, not a duplicate), carrying its instance.
    const runningRows = await deliveryGraphRuns(app.db).find({ status: "running" });
    assert.equal(runningRows.length, 1, "exactly one running run");
    assert.equal(runningRows[0]?.run_key, runKey, "the SAME run row was approved, not a new one");
    assert.equal(runningRows[0]?.process_key, dispatched.body.processInstanceKey);

    // ── Cockpit phase: the poller derives WHERE the run is parked (the human node) ─────────────────
    await pollDeliveryGraphPhase(app.db, app.engine);
    const phased = await deliveryGraphRuns(app.db).get(runKey);
    assert.equal(phased?.status, "running");
    assert.match(String(phased?.phase), /^Parked on human node:/, `phase shows the parked human node, got ${phased?.phase}`);

    // ── Idempotency: a duplicate submit short-circuits — the side effect never fires twice ────────
    const dup = await api.call<StartResult>("startDeliveryGraph", { body: { graph: GRAPH, approvalToken: token } });
    assert.equal(dup.status, 202);
    assert.equal(dup.body.alreadyRunning, true, "the re-submit short-circuited the already-running run");
    await app.settle();
    assert.equal(agentFired, 1, "the agent side effect STILL fired only once (no double-launch)");

    // ── Completion: complete the human stop → the instance ends → the poller reconciles to done ───
    const open = await app.engine.searchUserTasks({ state: "CREATED" });
    const human = open.find((t) => t.elementId?.startsWith("delivery-human-task__") && !t.elementId?.endsWith("__esc"));
    assert.ok(human, `a human user task is open, got ${JSON.stringify(open.map((t) => t.elementId))}`);
    await app.engine.completeUserTask(human.userTaskKey, { humanOutcome: "completed" });
    await app.settle();
    await pollDeliveryGraphPhase(app.db, app.engine);
    const done = await deliveryGraphRuns(app.db).get(runKey);
    assert.equal(done?.status, "done", "the completed instance reconciled the run to done");
    assert.equal(done?.phase, "Completed");
  });

  test("a non-side-effecting (human-only) graph dispatches with NO approval", async () => {
    const app = await boot();
    assert.ok(app.api);
    const graph: DeliveryGraph = { name: "manual gate", nodes: [{ id: "ack", kind: "human", human: { prompt: "click done" } }] };
    const res = await app.api.call<StartResult>("startDeliveryGraph", { body: { graph } });
    assert.equal(res.status, 202, "a graph with no side effects needs no approval");
    assert.equal(res.body.status, "running");
    assert.equal(res.body.sideEffecting, false);
    assert.ok(res.body.processInstanceKey);
  });
});
