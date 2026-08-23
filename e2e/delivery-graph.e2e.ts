// End-to-end proof that a COMPILED delivery graph deploys and runs ENGINE-NATIVELY on the WASM engine
// + virtual clock (ADR 0005 slice S4) — the integration acceptance the whole slice hinges on. Driven
// via `bootTestApp`, hermetic (deterministic shell-builtin `command` probes, no network, no GitHub;
// the `pr` kind's merge-state semantics are S2's surface, proven there — S4 proves the wait NODE
// executes engine-natively and gates, whatever the probe kind):
//
//   • RUNS END-TO-END + FAN-IN + LATE-BIND: a graph with `agent`, `wait`, `human` and `connector`
//     nodes deploys and runs; the agent job fires, the wait gate resolves, the human task completes,
//     the connector fires — and the graph reaches End only after the wait AND the human both feed the
//     connector (fan-in). The human's emitted `artifact` fact LATE-BINDS into the connector's input.
//   • RESUME NEVER DOUBLE-FIRES: after the connector has fired once, an at-least-once redelivery of the
//     same dispatch (a resume) DEDUPES — the durable ledger still holds exactly one row (Decision 7).
//   • CONCURRENCY-CORRECTNESS: while a `wait` is parked on a never-green probe, completing an UNRELATED
//     parallel human node does NOT falsely resolve the wait (the node polls its OWN target — there is no
//     shared message correlation an unrelated event could trip, inheriting #274/S2); the wait stays
//     parked until its bounded budget elapses, then escalates (bounded → escalate, never wedged).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";
import { connectorDedupeKey, deliveryConnectorDispatches, dispatchConnector } from "../app/deliveryConnector.ts";
import { readConnectorInput } from "../workers/delivery-connector/worker.ts";
import { runDeliveryGraph } from "../app/deliveryRunner.ts";
import type { DeliveryGraph } from "../nano-generated/api-io.d.ts";
import { deterministicProbeSeam } from "./support/probe-exec.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");
const GITHUB_ENV: Record<string, string> = { NANO_PR_GITHUB_TRANSPORT: "token", GITHUB_TOKEN: "" };

interface TakenFlow {
  from: string;
  to: string;
}
function takenFlows(app: TestApp): string[] {
  const snap = app.snapshot();
  const flows = Array.isArray(snap.takenSequenceFlows) ? snap.takenSequenceFlows : [];
  return flows
    .filter((f): f is TakenFlow => typeof f === "object" && f !== null && "from" in f && "to" in f)
    .map((f) => `${f.from}->${f.to}`);
}

/** Boot a fresh app per scenario (the WASM engine's taken-flow snapshot is engine-global cumulative). */
async function boot(dir: string): Promise<TestApp> {
  return bootTestApp(APP_ROOT, { env: { ...GITHUB_ENV, NANO_APP_DB_URL: `file:${join(dir, "app.db")}` } });
}

describe("delivery-graph runner — engine-native execution (S4)", () => {
  const dirs: string[] = [];
  const apps: TestApp[] = [];
  const freshDir = (): string => {
    const d = mkdtempSync(join(tmpdir(), "nwf-delivery-e2e-"));
    dirs.push(d);
    return d;
  };
  const track = (app: TestApp): TestApp => {
    apps.push(app);
    return app;
  };
  // The `wait` nodes drive `command: true`/`false` probes through the shared readiness-probe worker.
  // Inject the deterministic exec so they resolve within the virtual clock's drain fixpoint instead
  // of racing a real subprocess `settle()` cannot await (issue #450).
  const probeSeam = deterministicProbeSeam("delivery-graph e2e");
  before(() => probeSeam.install());
  after(async () => {
    for (const app of apps) await app.stop?.();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    probeSeam.restoreAndAssertHermetic();
  });

  test("runs end-to-end: agent, wait, human execute; edges gate; fan-in works; human fact late-binds into the connector", async () => {
    const app = track(await boot(freshDir()));

    let agentFired = 0;
    let connectorBoundFacts: unknown;
    await app.engine.registerWorker("senior:demo", async () => {
      agentFired++;
      return {};
    });
    // Wrap the REAL connector job path so we can observe the late-bound facts it received. The worker
    // itself is registered from the manifest; here we register a same-type observer stub for the e2e.
    // Mirror the REAL worker's normalization — `readConnectorInput` (trim+require `target`, coerce a
    // wrong-shaped payload/boundFacts) and `connectorDedupeKey` (derive the effective key from the
    // author key OR the engine identity `processInstanceKey:elementId`, fail closed if neither) — so
    // this observer exercises the same fail-closed/derivation behavior the production worker does and
    // a regression in that surface can't hide behind a `String(... ?? "")` coercion.
    await app.engine.registerWorker(
      "pr.delivery-connector",
      async (job) => {
        const vars = job.variables as Record<string, unknown>;
        connectorBoundFacts = vars.boundFacts;
        const { target, payload, boundFacts } = readConnectorInput(
          vars as Parameters<typeof readConnectorInput>[0],
        );
        const dedupeKey = connectorDedupeKey({
          dedupeKey: (vars.dedupeKey as string | null | undefined) ?? null,
          processInstanceKey: job.processInstanceKey ?? null,
          elementId: job.elementId ?? null,
        });
        if (!dedupeKey) {
          throw new Error("delivery-connector: no dedupe key (author-supplied or graph-derived) available");
        }
        return await dispatchConnector(
          app.db,
          { dedupeKey, target, payload, boundFacts },
          new Date().toISOString(),
        );
      },
      { fetchVariables: ["boundFacts", "target", "dedupeKey", "payload"] },
    );

    const graph: DeliveryGraph = {
      name: "e2e end-to-end",
      nodes: [
        { id: "a", kind: "agent", agent: { jobType: "senior:demo" } },
        { id: "w", kind: "wait", wait: { kind: "command", target: "true", poll: { everyMs: 5, backoff: "fixed" } } },
        { id: "h", kind: "human", emits: [{ name: "art", type: "artifact" }] },
        { id: "c", kind: "connector", connector: { target: "slack", dedupeKey: "c-e2e-1" } },
      ],
      edges: [
        { from: "a", to: "h" },
        { from: "h.art", to: "c" },
        { from: "w", to: "c" },
      ],
    };

    const run = await runDeliveryGraph(app.engine, graph, { probeTimeout: "PT2S" });
    assert.ok(run.ok, `graph should deploy + run, got ${JSON.stringify(run)}`);
    await app.settle();

    // The agent node executed via its engine-native serviceTask body.
    assert.equal(agentFired, 1, "the agent node's job fired once");

    // The human node scheduled its per-node user task (the isDeliveryHumanElement convention id).
    const open = await app.engine.searchUserTasks({ state: "CREATED" });
    const human = open.find((t) => t.elementId?.startsWith("delivery-human-task__") && !t.elementId?.endsWith("__esc"));
    assert.ok(human, `a human user task is open, got ${JSON.stringify(open.map((t) => t.elementId))}`);

    // Before the human completes, the connector has NOT fired — the fan-in edge from `h` gates it.
    assert.equal((await deliveryConnectorDispatches(app.db).find({})).length, 0, "connector waits on the human edge");

    // Complete the human with a resolved artifact — its typed emit late-binds downstream.
    await app.engine.completeUserTask(human.userTaskKey, { resolvedArtifact: "ARTIFACT-1", humanOutcome: "completed" });
    await app.settle();

    // The connector fired exactly once (fan-in of the wait AND the human both satisfied), and it
    // received the human's emitted fact as a late-bound input.
    const rows = await deliveryConnectorDispatches(app.db).find({ dedupe_key: "c-e2e-1" });
    assert.equal(rows.length, 1, "the connector fired exactly once");
    assert.equal(rows[0].outcome, "delivered");
    assert.deepEqual(connectorBoundFacts, [{ from: "h", name: "art", value: "ARTIFACT-1" }], "the human fact late-binds into the connector");

    // The graph reached End — the fan-in join released only after BOTH upstream branches completed.
    assert.ok(takenFlows(app).some((f) => f.endsWith("->End")), "the graph reached its End event");
  });

  test("resume never double-fires: an at-least-once redelivery of the connector dedupes", async () => {
    const app = track(await boot(freshDir()));
    // The connector fired once above's-style; here prove the idempotency directly against the ledger a
    // resumed graph shares. First dispatch delivers; a redelivery of the SAME dispatch (the resume) is
    // deduped and the durable ledger still holds exactly ONE row — the side effect never re-fires.
    const first = await dispatchConnector(app.db, { dedupeKey: "resume-1", target: "slack" }, new Date().toISOString());
    assert.equal(first.connectorOutcome, "delivered");
    const replay = await dispatchConnector(app.db, { dedupeKey: "resume-1", target: "slack" }, new Date().toISOString());
    assert.equal(replay.connectorOutcome, "deduped", "a resume redelivery dedupes");
    assert.equal((await deliveryConnectorDispatches(app.db).find({ dedupe_key: "resume-1" })).length, 1, "exactly one durable dispatch");
  });

  test("concurrency-correctness: an unrelated human completion does not falsely resolve a parked wait", async () => {
    const app = track(await boot(freshDir()));
    // Two independent parallel branches: a NEVER-GREEN wait, and an unrelated human. The wait polls its
    // own `false` target (never ready) — there is NO shared correlation an unrelated event could trip.
    const graph: DeliveryGraph = {
      name: "e2e concurrency",
      nodes: [
        { id: "gate", kind: "wait", wait: { kind: "command", target: "false", poll: { everyMs: 5, backoff: "fixed" } } },
        { id: "side", kind: "human", emits: [{ name: "ok", type: "string" }] },
      ],
      edges: [],
    };
    const run = await runDeliveryGraph(app.engine, graph, { probeTimeout: "PT2S", probePollEvery: "PT1S", escalationSlaTimeout: "PT1H" });
    assert.ok(run.ok, `graph should deploy + run, got ${JSON.stringify(run)}`);
    await app.settle();

    // Complete the UNRELATED human node — an upstream event with no edge to the wait.
    const open = await app.engine.searchUserTasks({ state: "CREATED" });
    const side = open.find((t) => t.elementId?.startsWith("delivery-human-task__") && !t.elementId?.endsWith("__esc"));
    assert.ok(side, "the unrelated human task is open");
    await app.engine.completeUserTask(side.userTaskKey, { value: "done", humanOutcome: "completed" });
    await app.settle();

    // The wait polls `false` — it can NEVER resolve as ready, so completing the unrelated human could
    // not trip it: the graph never reaches End (the wait never released its "ready" branch). Instead the
    // wait is BOUNDED — its poll budget elapses and it escalates onto a human-completable task, parking
    // for a human rather than silently wedging or falsely resolving.
    assert.ok(!takenFlows(app).some((f) => f.endsWith("->End")), "the wait branch never falsely resolves to End");
    await app.advanceTime(2_100);
    const esc = (await app.engine.searchUserTasks({ state: "CREATED" })).filter((t) => t.elementId?.endsWith("__esc"));
    assert.ok(
      esc.length >= 1,
      `the parked wait escalates (bounded), never falsely resolved by the unrelated event, got ${JSON.stringify((await app.engine.searchUserTasks({ state: "CREATED" })).map((t) => t.elementId))}`,
    );
  });
});
