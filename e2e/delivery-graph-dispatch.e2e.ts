// End-to-end proof of the OPERATOR DISPATCH flow (ADR 0005 Decision 7, issue #460) driven through its
// REAL ingress: the agent `compileDeliveryGraph` door STAGES a proposal, and the operator
// `dispatchDeliveryGraph` door launches the one the operator picked BY DIGEST. Hermetic: deterministic
// virtual clock, no network. It proves the acceptance the slice hinges on:
//
//   • AGENT SURFACE ENDS AT STAGE: compiling a side-effecting graph returns a `ready` preview + a
//     content `digest` and STAGES a durable `delivery_graph_proposals` row — but NO run key, token, or
//     PIK, and NO engine instance is started (the agent cannot reach a run through its surface).
//   • OPERATOR DISPATCH: dispatching that digest deploys + runs the graph engine-natively (the agent
//     side effect fires), marks the proposal `dispatched`, and the run's derived phase shows WHERE it
//     is parked ("Parked on human node: …") via the same `pollDeliveryGraphPhase` projection.
//   • NO REPLAY: there is no agent `start/delivery-graph` operation to call — the self-approval hole is
//     closed by absence.
//   • COMPLETION: when the instance ends, the poller reconciles the run to `done`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";
import { deliveryGraphProposals } from "../app/deliveryGraphProposals.ts";
import { deliveryGraphRuns } from "../app/deliveryGraphRun.ts";
import { pollDeliveryGraphPhase } from "../app/service.ts";
import type { DeliveryGraph } from "../nano-generated/api-io.d.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");
const GITHUB_ENV: Record<string, string> = { NANO_PR_GITHUB_TRANSPORT: "token", GITHUB_TOKEN: "" };

interface StagedResult {
  status: string;
  message: string;
  digest: string;
  reviewUrl?: string;
}
interface DispatchResult {
  ok: boolean;
  status?: string;
  runKey?: string;
  digest?: string;
  sideEffecting?: boolean;
  alreadyRunning?: boolean;
  processInstanceKey?: string;
  error?: string;
}

// A side-effecting graph: an `agent` side effect gated ahead of a `human` stop. Dispatch is an operator
// action (the agent + the human-facing merge/publish class of graphs Decision 7 protects).
const GRAPH: DeliveryGraph = {
  name: "release runbook e2e",
  nodes: [
    { id: "open", kind: "agent", agent: { jobType: "senior:demo", prompt: "open + prep" } },
    { id: "publish", kind: "human", human: { prompt: "run the manual OTP publish" } },
  ],
  edges: [{ from: "open", to: "publish" }],
};

describe("delivery-graph dispatch — agent compiles→stages, operator dispatches by digest, idempotent (#460)", () => {
  const dirs: string[] = [];
  const apps: TestApp[] = [];
  after(async () => {
    for (const app of apps) await app.stop?.();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const boot = async (): Promise<TestApp> => {
    const d = mkdtempSync(join(tmpdir(), "nwf-delivery-dispatch-e2e-"));
    dirs.push(d);
    const app = await bootTestApp(APP_ROOT, { env: { ...GITHUB_ENV, NANO_APP_DB_URL: `file:${join(d, "app.db")}` } });
    apps.push(app);
    return app;
  };

  test("the agent compile door stages a proposal (no run handle); the operator dispatches it by digest, once", async () => {
    const app = await boot();
    assert.ok(app.api, "app declares an `api` binding");
    const api = app.api;

    let agentFired = 0;
    await app.engine.registerWorker("senior:demo", async () => {
      agentFired++;
      return {};
    });

    // ── Agent surface ends at stage: compile → ready + digest, staged, NOTHING launched ───────────
    const staged = await api.call<StagedResult>("compileDeliveryGraph", { body: GRAPH });
    assert.equal(staged.status, 200, "a valid graph compiles");
    assert.equal(staged.body.status, "ready");
    assert.ok(staged.body.digest, "the response carries the content digest that names the proposal");
    // The self-approval hole is closed by ABSENCE: no run key / token / PIK in the response.
    assert.equal((staged.body as unknown as Record<string, unknown>).runKey, undefined);
    assert.equal((staged.body as unknown as Record<string, unknown>).approvalToken, undefined);
    assert.equal((staged.body as unknown as Record<string, unknown>).processInstanceKey, undefined);
    await app.settle();
    assert.equal(agentFired, 0, "a staged graph never dispatched its side effect");
    assert.equal((await deliveryGraphRuns(app.db).all()).length, 0, "no run row while merely staged");

    // The proposal is durable + visible for operator dispatch.
    const digest = staged.body.digest;
    const proposal = await deliveryGraphProposals(app.db).get(digest);
    assert.ok(proposal, "a delivery_graph_proposals row exists for the staged graph");
    assert.equal(proposal?.status, "staged");

    // ── Operator dispatch: dispatch the digest → deploys + runs engine-natively ───────────────────
    const dispatched = await api.call<DispatchResult>("dispatchDeliveryGraph", { body: { digest } });
    assert.equal(dispatched.status, 202, "dispatching a staged digest launches the run");
    assert.equal(dispatched.body.status, "running");
    assert.equal(dispatched.body.alreadyRunning, false);
    assert.ok(dispatched.body.processInstanceKey, "the run carries the started engine instance key");
    await app.settle();
    assert.equal(agentFired, 1, "the agent side effect fired exactly once");
    assert.equal((await deliveryGraphProposals(app.db).get(digest))?.status, "dispatched", "the proposal is consumed");

    // Exactly one running run, carrying its instance.
    const runningRows = await deliveryGraphRuns(app.db).find({ status: "running" });
    assert.equal(runningRows.length, 1, "exactly one running run");
    assert.equal(runningRows[0]?.process_key, dispatched.body.processInstanceKey);
    const runKey = runningRows[0]?.run_key as string;

    // ── Cockpit phase: the poller derives WHERE the run is parked (the human node) ─────────────────
    await pollDeliveryGraphPhase(app.db, app.engine);
    const phased = await deliveryGraphRuns(app.db).get(runKey);
    assert.equal(phased?.status, "running");
    assert.match(String(phased?.phase), /^Parked on human node:/, `phase shows the parked human node, got ${phased?.phase}`);

    // ── No replay: the consumed proposal cannot re-launch ─────────────────────────────────────────
    const replay = await api.call<DispatchResult>("dispatchDeliveryGraph", { body: { digest } });
    assert.equal(replay.status, 400, "an already-dispatched digest cannot be re-dispatched");
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

  test("a non-side-effecting (human-only) graph: stage then dispatch runs it straight away", async () => {
    const app = await boot();
    assert.ok(app.api);
    const api = app.api;
    const graph: DeliveryGraph = { name: "manual gate", nodes: [{ id: "ack", kind: "human", human: { prompt: "click done" } }] };
    const staged = await api.call<StagedResult>("compileDeliveryGraph", { body: graph });
    assert.equal(staged.status, 200);
    const res = await api.call<DispatchResult>("dispatchDeliveryGraph", { body: { digest: staged.body.digest } });
    assert.equal(res.status, 202, "dispatching a human-only graph runs it");
    assert.equal(res.body.status, "running");
    assert.equal(res.body.sideEffecting, false);
    assert.ok(res.body.processInstanceKey);
  });
});
