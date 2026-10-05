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
import type { CommandResult } from "../app/readiness.ts";
import { readConnectorInput } from "../workers/delivery-connector/worker.ts";
import { __setProbeExecForTest } from "../workers/readiness-probe/worker.ts";
import { prepareDeliveryGraph, runDeliveryGraph } from "../app/deliveryRunner.ts";
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

/** Await the re-parked `__esc` escalation user task after a resume, re-settling briefly so the
 * resume-validation gateway's loop-back (esc → gate → esc) fully materialises the fresh task before
 * it is searched. The gate's re-park is engine-synchronous but can straddle a `settle()` fixpoint, so
 * a single immediate search can race it; a bounded re-settle loop makes the assertion deterministic
 * (no wall-clock sleep). */
async function waitForEsc(app: TestApp): Promise<{ userTaskKey: string; elementId?: string } | undefined> {
  for (let i = 0; i < 10; i++) {
    const esc = (await app.engine.searchUserTasks({ state: "CREATED" })).find((t) => t.elementId?.endsWith("__esc"));
    if (esc) return esc;
    await app.settle();
  }
  return undefined;
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

    const run = await runDeliveryGraph(app.engine, graph, { probeTimeout: "PT2S", repoless: true });
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

  test("#548 wait target LATE-BINDS from an upstream fact via FEEL `context put` (engine-native)", async () => {
    const app = track(await boot(freshDir()));

    // The agent emits a `cmd` fact whose OBSERVED value is the deterministic green probe command
    // ("true"). The downstream wait references that fact as its probe `target` (`a.cmd`) — the compiler
    // rewrites the seeded probe's target via FEEL `context put`, so the probe polls the LATE-BOUND
    // value, not a hardcoded literal. This is the exact mechanism the canonical `agent →
    // connector[converge-merge] → wait[pr, merged]` shape uses to poll the PR the agent opened (#548).
    await app.engine.registerWorker("senior:demo", async () => ({ cmd: "true" }));

    const graph: DeliveryGraph = {
      name: "e2e wait late-bind",
      nodes: [
        { id: "a", kind: "agent", agent: { jobType: "senior:demo" }, emits: [{ name: "cmd", type: "string" }] },
        { id: "w", kind: "wait", wait: { kind: "command", target: "a.cmd", poll: { everyMs: 5, backoff: "fixed" } } },
      ],
      edges: [{ from: "a.cmd", to: "w" }],
    };

    const run = await runDeliveryGraph(app.engine, graph, { probeTimeout: "PT2S", repoless: true });
    assert.ok(run.ok, `graph should deploy + run, got ${JSON.stringify(run)}`);
    await app.settle();

    // The wait's probe ran the LATE-BOUND command "true" (green) — had `context put` not resolved the
    // `a.cmd` reference to "true", the probe would have run the literal "a.cmd" (a probe escape the
    // hermetic seam records + fails on), and the gate would never have resolved. The graph reaching End
    // proves the wait released its ready branch off the late-bound target.
    assert.ok(takenFlows(app).some((f) => f.endsWith("->End")), "the late-bound wait resolved and the graph reached End");
  });

  test("#876 review: a DOTTED command literal target (check.sh) is NOT misclassified as an unresolved fact-ref — the gate probes it and resolves", async () => {
    const app = track(await boot(freshDir()));

    // PR #876 review finding: the #872 fail-closed guard keyed on a fact-ref SYNTAX test
    // (`isFactRefTarget`), which a valid dotted command target like `check.sh` also satisfies — so the
    // gate would have parked forever without ever running the probe. The fix moves the
    // resolved/unresolved provenance into the COMPILER (an unresolved late-bind writes null), so a
    // dotted literal reaches the probe verbatim. The deterministic seam maps the hermetic `true`/
    // `false` builtins; `check.sh` itself would be an escape, so the upstream agent late-binds the
    // dotted literal — proving it flows through the late-bind machinery to the probe UNTOUCHED.
    let probed: string[] = [];
    const restore = __setProbeExecForTest({
      run(command: string): Promise<CommandResult> {
        probed.push(command);
        // The dotted literal is the probe under test; treat it green so the gate can resolve.
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      httpGet(): Promise<never> {
        return Promise.reject(new Error("unexpected http probe"));
      },
    });
    try {
      await app.engine.registerWorker("senior:demo", async () => ({ cmd: "check.sh" }));

      const graph: DeliveryGraph = {
        name: "e2e dotted command literal",
        nodes: [
          { id: "a", kind: "agent", agent: { jobType: "senior:demo" }, emits: [{ name: "cmd", type: "string" }] },
          { id: "w", kind: "wait", wait: { kind: "command", target: "a.cmd", poll: { everyMs: 5, backoff: "fixed" } } },
        ],
        edges: [{ from: "a.cmd", to: "w" }],
      };

      const run = await runDeliveryGraph(app.engine, graph, { probeTimeout: "PT2S", repoless: true });
      assert.ok(run.ok, `graph should deploy + run, got ${JSON.stringify(run)}`);
      await app.settle();

      // The dotted late-bound value reached the probe VERBATIM (not parked as an "unresolved fact-ref")
      // and the gate resolved on it — the graph reached End.
      assert.deepEqual(probed, ["check.sh"], "the dotted command target was probed, not misclassified as unresolved");
      assert.ok(takenFlows(app).some((f) => f.endsWith("->End")), "the dotted-target wait resolved and the graph reached End");
    } finally {
      __setProbeExecForTest(restore);
      probed = [];
    }
  });

  test("#731 producer contract gate: an agent that completes with status=in_progress and a null required emit escalates AT the producer, does NOT thread null downstream, and resumes", async () => {
    const app = track(await boot(freshDir()));

    // The instance-10746 failure mode: the agent's job COMPLETES, but it broke its node contract —
    // it self-reports `status: "in_progress"` and never opened the PR, so its required `pr` emit is
    // null. Before #731 this threaded `open_pr = null` through to the connector, which then failed with
    // a mis-attributed CONSUMER incident. The producer gate must instead park THIS node.
    let agentFired = 0;
    await app.engine.registerWorker("senior:demo", async () => {
      agentFired++;
      return { status: "in_progress", summary: "delegated to a background agent; PR not opened." };
    });
    let connectorFired = 0;
    await app.engine.registerWorker(
      "pr.delivery-connector",
      async (job) => {
        connectorFired++;
        const vars = job.variables as Record<string, unknown>;
        const { target, payload, boundFacts } = readConnectorInput(vars as Parameters<typeof readConnectorInput>[0]);
        const dedupeKey = connectorDedupeKey({
          dedupeKey: (vars.dedupeKey as string | null | undefined) ?? null,
          processInstanceKey: job.processInstanceKey ?? null,
          elementId: job.elementId ?? null,
        });
        // Mirror the real worker's fail-closed contract: an un-dedupable dispatch (no author key AND
        // no engine identity) throws rather than papering over it with a hardcoded fallback that would
        // mask a regression where the connector node stops seeding `dedupeKey`.
        if (!dedupeKey) throw new Error("connector stub: no dedupe key (author-supplied or graph-derived) available");
        return await dispatchConnector(app.db, { dedupeKey, target, payload, boundFacts }, new Date().toISOString());
      },
      { fetchVariables: ["boundFacts", "target", "dedupeKey", "payload"] },
    );

    const graph: DeliveryGraph = {
      name: "e2e producer gate",
      nodes: [
        { id: "open", kind: "agent", agent: { jobType: "senior:demo" }, emits: [{ name: "pr", type: "pr" }] },
        { id: "land", kind: "connector", connector: { target: "slack", payload: { pr: "open.pr" }, dedupeKey: "land-731" } },
      ],
      edges: [{ from: "open.pr", to: "land" }],
    };

    const run = await runDeliveryGraph(app.engine, graph, { escalationSlaTimeout: "PT1H", repoless: true });
    assert.ok(run.ok, `graph should deploy + run, got ${JSON.stringify(run)}`);
    await app.settle();

    // The agent job fired and COMPLETED — but the node did NOT succeed: it parked on its producer
    // contract escalation, the graph never reached End, and the downstream connector never fired on null.
    assert.equal(agentFired, 1, "the agent node's job fired and completed");
    assert.ok(!takenFlows(app).some((f) => f.endsWith("->End")), "the broken producer did NOT thread its result to End");
    assert.equal(connectorFired, 0, "the downstream connector never fired on a null required emit");
    const open = await app.engine.searchUserTasks({ state: "CREATED" });
    const contract = open.find((t) => t.elementId?.startsWith("delivery-human-task__") && t.elementId?.endsWith("__contract"));
    assert.ok(contract, `the producer escalates AT its node on its __contract task, got ${JSON.stringify(open.map((t) => t.elementId))}`);

    // Resumable (the issue's manual unblock): a human/agent supplies the eventually-created PR on the
    // contract task; the subProcess output mapping republishes `open_pr` non-null and the connector runs.
    await app.engine.completeUserTask(contract.userTaskKey, { value: "owner/repo#42", humanOutcome: "completed" });
    await app.settle();
    assert.equal(connectorFired, 1, "resuming the contract escalation with the missing PR unblocks the downstream connector");
    const rows = await deliveryConnectorDispatches(app.db).find({ dedupe_key: "land-731" });
    assert.equal(rows.length, 1, "the connector fired exactly once after resume");
    assert.ok(takenFlows(app).some((f) => f.endsWith("->End")), "the resumed producer's result reaches End");
  });

  test("#760 producer contract satisfied: an agent completing with an allowlisted status + its required emit passes the gate with NO __contract escalation and threads onward", async () => {
    const app = track(await boot(freshDir()));

    // The instance-15697 failure mode: the agent DID the work correctly and returned its required emit,
    // but self-reported an out-of-vocabulary `status` (e.g. "success") and so was wrongly parked on a
    // __contract escalation — because the terminal-status vocabulary lived ONLY in the gate. With #760
    // the vocabulary is auto-injected into the agent's appendPrompt (proven in the runner unit tests);
    // here we prove the gate's happy path: a status FROM `AGENT_TERMINAL_SUCCESS_STATUSES` ("opened")
    // WITH the required emit sails through — no escalation, the downstream connector fires.
    let agentFired = 0;
    await app.engine.registerWorker("senior:demo", async () => {
      agentFired++;
      return { status: "opened", pr: "owner/repo#99", summary: "PR opened and green." };
    });
    let connectorFired = 0;
    await app.engine.registerWorker(
      "pr.delivery-connector",
      async (job) => {
        connectorFired++;
        const vars = job.variables as Record<string, unknown>;
        const { target, payload, boundFacts } = readConnectorInput(vars as Parameters<typeof readConnectorInput>[0]);
        const dedupeKey = connectorDedupeKey({
          dedupeKey: (vars.dedupeKey as string | null | undefined) ?? null,
          processInstanceKey: job.processInstanceKey ?? null,
          elementId: job.elementId ?? null,
        });
        // Mirror the real worker's fail-closed contract: an un-dedupable dispatch (no author key AND
        // no engine identity) throws rather than papering over it with a hardcoded fallback that would
        // mask a regression where the connector node stops seeding `dedupeKey`.
        if (!dedupeKey) throw new Error("connector stub: no dedupe key (author-supplied or graph-derived) available");
        return await dispatchConnector(app.db, { dedupeKey, target, payload, boundFacts }, new Date().toISOString());
      },
      { fetchVariables: ["boundFacts", "target", "dedupeKey", "payload"] },
    );

    const graph: DeliveryGraph = {
      name: "e2e producer gate satisfied",
      nodes: [
        { id: "open", kind: "agent", agent: { jobType: "senior:demo" }, emits: [{ name: "pr", type: "pr" }] },
        { id: "land", kind: "connector", connector: { target: "slack", payload: { pr: "open.pr" }, dedupeKey: "land-760" } },
      ],
      edges: [{ from: "open.pr", to: "land" }],
    };

    const run = await runDeliveryGraph(app.engine, graph, { escalationSlaTimeout: "PT1H", repoless: true });
    assert.ok(run.ok, `graph should deploy + run, got ${JSON.stringify(run)}`);
    await app.settle();

    // The producer satisfied its contract (allowlisted status + non-null required emit): NO __contract
    // escalation was raised, the downstream connector fired once, and the graph reached End.
    assert.equal(agentFired, 1, "the agent node's job fired and completed");
    const createdTasks = await app.engine.searchUserTasks({ state: "CREATED" });
    const contract = createdTasks.find((t) => t.elementId?.startsWith("delivery-human-task__") && t.elementId?.endsWith("__contract"));
    assert.ok(!contract, `an allowlisted status + required emit must NOT escalate, got ${JSON.stringify(createdTasks.map((t) => t.elementId))}`);
    assert.equal(connectorFired, 1, "the satisfied producer threads its result to the downstream connector");
    assert.ok(takenFlows(app).some((f) => f.endsWith("->End")), "the satisfied producer's result reaches End");
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
    const run = await runDeliveryGraph(app.engine, graph, { probeTimeout: "PT2S", probePollEvery: "PT1S", escalationSlaTimeout: "PT1H", repoless: true });
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

  test("#872 timeout escalation value BINDS the node's emit: a timed-out agent, unstuck with `value`, threads that value downstream (not null)", async () => {
    const app = track(await boot(freshDir()));

    // The instance-216710 failure mode: an agent node that owes a required `pr` emit TIMES OUT (its job
    // never completes). Its bounded `=nodeTimeout` boundary fires and parks the node on its `__esc`
    // timeout escalation. A human/agent unsticks it by supplying the eventually-created PR as `value`.
    // Before #872 the `__esc` had NO resume output mapping, so completing it published `open_pr = null`
    // — the downstream connector then bound `pr = null`. The fix makes the timeout `__esc` resumable:
    // `value` maps onto the node's emit-source var and the subProcess republishes `open_pr` non-null.
    // We deliberately DO NOT register `senior:demo`, so the agent job parks and only the timer fires.
    let connectorBoundFacts: unknown;
    let connectorFired = 0;
    await app.engine.registerWorker(
      "pr.delivery-connector",
      async (job) => {
        connectorFired++;
        const vars = job.variables as Record<string, unknown>;
        connectorBoundFacts = vars.boundFacts;
        const { target, payload, boundFacts } = readConnectorInput(vars as Parameters<typeof readConnectorInput>[0]);
        const dedupeKey = connectorDedupeKey({
          dedupeKey: (vars.dedupeKey as string | null | undefined) ?? null,
          processInstanceKey: job.processInstanceKey ?? null,
          elementId: job.elementId ?? null,
        });
        if (!dedupeKey) throw new Error("connector stub: no dedupe key (author-supplied or graph-derived) available");
        return await dispatchConnector(app.db, { dedupeKey, target, payload, boundFacts }, new Date().toISOString());
      },
      { fetchVariables: ["boundFacts", "target", "dedupeKey", "payload"] },
    );

    const graph: DeliveryGraph = {
      name: "e2e timeout escalation binds emit",
      nodes: [
        { id: "open", kind: "agent", agent: { jobType: "senior:demo" }, emits: [{ name: "pr", type: "pr" }] },
        { id: "land", kind: "connector", connector: { target: "slack", payload: { pr: "open.pr" }, dedupeKey: "land-872a" } },
      ],
      edges: [{ from: "open.pr", to: "land" }],
    };

    const run = await runDeliveryGraph(app.engine, graph, { nodeTimeout: "PT2S", escalationSlaTimeout: "PT1H", repoless: true });
    assert.ok(run.ok, `graph should deploy + run, got ${JSON.stringify(run)}`);
    await app.settle();

    // The job never completed (no worker) and the timer has not elapsed: no escalation yet, no End.
    assert.ok(
      (await app.engine.searchUserTasks({ state: "CREATED" })).every((t) => !t.elementId?.endsWith("__esc")),
      "the timeout escalation has not fired before the SLA elapses",
    );

    // Elapse the node SLA → the `=nodeTimeout` boundary fires and parks the node on its timeout `__esc`.
    await app.advanceTime(2_100);
    const esc = (await app.engine.searchUserTasks({ state: "CREATED" })).find((t) => t.elementId?.endsWith("__esc"));
    assert.ok(esc, "the timed-out agent parks on its timeout escalation task");
    assert.equal(connectorFired, 0, "the downstream connector has not fired before the escalation resolves");

    // Unstick it with the missing PR as `value` — the #872 resume output must bind `open_pr` to it.
    await app.engine.completeUserTask(esc.userTaskKey, { value: "owner/repo#872", humanOutcome: "completed" });
    await app.settle();

    assert.equal(connectorFired, 1, "resuming the timeout escalation with `value` unblocks the downstream connector");
    assert.deepEqual(
      connectorBoundFacts,
      [{ from: "open", name: "pr", value: "owner/repo#872" }],
      "the escalation `value` binds the node's `pr` emit and late-binds downstream (NOT null)",
    );
    const rows = await deliveryConnectorDispatches(app.db).find({ dedupe_key: "land-872a" });
    assert.equal(rows.length, 1, "the connector fired exactly once after the resume");
    assert.ok(takenFlows(app).some((f) => f.endsWith("->End")), "the resumed node's result reaches End");
  });

  test("#876 review: a timeout escalation resumed with a MISSING or MALFORMED value re-parks (validated), never threads null/garbage downstream", async () => {
    const app = track(await boot(freshDir()));

    // PR #876 review finding: the resumable timeout `__esc` mapped the form's optional `value`
    // straight onto the emit-source var, so completing it with `{}` (or a malformed value) released
    // the downstream consumer with a null/invalid fact. The fix routes the resume through a
    // validation gateway: the task re-publishes to a scratch var, and a per-required-emit FEEL
    // condition binds the emit-source var ONLY when the value is present and type-valid — otherwise
    // the node loops back onto a fresh escalation task (fail closed).
    let connectorFired = 0;
    let connectorBoundFacts: unknown;
    await app.engine.registerWorker(
      "pr.delivery-connector",
      async (job) => {
        connectorFired++;
        const vars = job.variables as Record<string, unknown>;
        connectorBoundFacts = vars.boundFacts;
        const { target, payload, boundFacts } = readConnectorInput(vars as Parameters<typeof readConnectorInput>[0]);
        const dedupeKey = connectorDedupeKey({
          dedupeKey: (vars.dedupeKey as string | null | undefined) ?? null,
          processInstanceKey: job.processInstanceKey ?? null,
          elementId: job.elementId ?? null,
        });
        if (!dedupeKey) throw new Error("connector stub: no dedupe key (author-supplied or graph-derived) available");
        return await dispatchConnector(app.db, { dedupeKey, target, payload, boundFacts }, new Date().toISOString());
      },
      { fetchVariables: ["boundFacts", "target", "dedupeKey", "payload"] },
    );

    const graph: DeliveryGraph = {
      name: "e2e resume validation",
      nodes: [
        { id: "open", kind: "agent", agent: { jobType: "senior:demo" }, emits: [{ name: "pr", type: "pr" }] },
        { id: "land", kind: "connector", connector: { target: "slack", payload: { pr: "open.pr" }, dedupeKey: "land-876v" } },
      ],
      edges: [{ from: "open.pr", to: "land" }],
    };

    // `senior:demo` is never registered, so the node parks and only its SLA timer fires.
    const run = await runDeliveryGraph(app.engine, graph, { nodeTimeout: "PT2S", escalationSlaTimeout: "PT1H", repoless: true });
    assert.ok(run.ok, `graph should deploy + run, got ${JSON.stringify(run)}`);
    await app.settle();
    await app.advanceTime(2_100);
    const esc = (await app.engine.searchUserTasks({ state: "CREATED" })).find((t) => t.elementId?.endsWith("__esc"));
    assert.ok(esc, "the timed-out agent parks on its timeout escalation task");

    // (a) Resume with NO value — the missing required `pr` emit must NOT release downstream.
    await app.engine.completeUserTask(esc.userTaskKey, { humanOutcome: "completed" });
    await app.settle();
    assert.equal(connectorFired, 0, "a value-less resume never fires the downstream connector");
    assert.ok(!takenFlows(app).some((f) => f.endsWith("->End")), "a value-less resume never reaches End");
    const reparked = await waitForEsc(app);
    assert.ok(reparked, "the invalid resume loops back onto a fresh escalation task (fail closed)");

    // (b) Resume with a MALFORMED `pr` value — same fail-closed re-park.
    await app.engine.completeUserTask(reparked.userTaskKey, { value: "not-a-pr-key", humanOutcome: "completed" });
    await app.settle();
    assert.equal(connectorFired, 0, "a malformed resume value never fires the downstream connector");
    const reparked2 = await waitForEsc(app);
    assert.ok(reparked2, "the malformed resume loops back onto a fresh escalation task");

    // (c) Resume with a VALID `pr` value — the gate binds the emit-source var and releases downstream.
    await app.engine.completeUserTask(reparked2.userTaskKey, { value: "owner/repo#876", humanOutcome: "completed" });
    await app.settle();
    assert.equal(connectorFired, 1, "a valid resume value unblocks the downstream connector");
    assert.deepEqual(connectorBoundFacts, [{ from: "open", name: "pr", value: "owner/repo#876" }], "the validated value late-binds downstream");
    assert.ok(takenFlows(app).some((f) => f.endsWith("->End")), "the validated resume reaches End");
  });

  test("#872 a wait gate whose target resolves to NULL fails closed: it does NOT pass through, it parks and escalates", async () => {
    const app = track(await boot(freshDir()));

    // The instance-216710 downstream failure: a `wait` gate late-binds its probe `target` from an
    // upstream emit (`up.cmd`). When that upstream fact resolves to NULL, the compiler leaves the
    // authored `<node>.<fact>` reference in place rather than rewriting it to a real handle. Before
    // #872 that null/fact-ref target threaded through as if the gate were satisfiable (it passed
    // through / incidented). The fix makes the readiness worker fail CLOSED on an unresolved target, so
    // the gate stays parked and escalates on its bounded timeout. The upstream here is a CONNECTOR
    // (no producer-contract gate), so its null emit is not caught upstream and genuinely reaches the gate.
    await app.engine.registerWorker(
      "pr.delivery-connector",
      async (job) => {
        const vars = job.variables as Record<string, unknown>;
        const { target, payload, boundFacts } = readConnectorInput(vars as Parameters<typeof readConnectorInput>[0]);
        const dedupeKey = connectorDedupeKey({
          dedupeKey: (vars.dedupeKey as string | null | undefined) ?? null,
          processInstanceKey: job.processInstanceKey ?? null,
          elementId: job.elementId ?? null,
        });
        if (!dedupeKey) throw new Error("connector stub: no dedupe key (author-supplied or graph-derived) available");
        // Return the dispatch outcome only — it NEVER sets `cmd`, so the node's `cmd` emit is null.
        return await dispatchConnector(app.db, { dedupeKey, target, payload, boundFacts }, new Date().toISOString());
      },
      { fetchVariables: ["boundFacts", "target", "dedupeKey", "payload"] },
    );

    const graph: DeliveryGraph = {
      name: "e2e null wait target fails closed",
      nodes: [
        { id: "up", kind: "connector", connector: { target: "noop", dedupeKey: "up-872b" }, emits: [{ name: "cmd", type: "string" }] },
        { id: "w", kind: "wait", wait: { kind: "command", target: "up.cmd", poll: { everyMs: 5, backoff: "fixed" } } },
      ],
      edges: [{ from: "up.cmd", to: "w" }],
    };

    const run = await runDeliveryGraph(app.engine, graph, { probeTimeout: "PT2S", probePollEvery: "PT1S", escalationSlaTimeout: "PT1H", repoless: true });
    assert.ok(run.ok, `graph should deploy + run, got ${JSON.stringify(run)}`);
    await app.settle();

    // The upstream connector completed (no gate), threading `up_cmd = null`. The wait's target stays the
    // unresolved `up.cmd` fact-ref → the worker fails closed → the gate NEVER resolves to ready.
    assert.ok(!takenFlows(app).some((f) => f.endsWith("->End")), "a gate with a null target must NOT pass through to End");

    // Bounded, not wedged: the gate escalates once its poll budget elapses.
    await app.advanceTime(2_100);
    const esc = (await app.engine.searchUserTasks({ state: "CREATED" })).filter((t) => t.elementId?.endsWith("__esc"));
    assert.ok(esc.length >= 1, `the unresolved-target gate escalates (bounded), got ${JSON.stringify((await app.engine.searchUserTasks({ state: "CREATED" })).map((t) => t.elementId))}`);
  });

  test("#872 a node released with NO per-node timeout gets the default SLA — not a zero-length timer that fires instantly", async () => {
    const app = track(await boot(freshDir()));

    // The instance-216710 third failure: nodes released with `nodeTimeout = null` fired their SLA
    // boundary almost immediately (~0.5s) — a null `=nodeTimeout` duration. The fix makes the
    // bounded-timeout ioMapping fall back to the run-level `runNodeTimeout` (then a `PT1H` literal). We
    // simulate the degenerate seed by nulling the node's per-node `timeout` in the prepared inputs, then
    // deploy + start manually. If the bug were present the `__esc` would appear during `settle()` (an
    // instant timer); with the fallback the node waits the real `runNodeTimeout` SLA first.
    await app.engine.registerWorker("senior:demo", async () => ({}));

    const graph: DeliveryGraph = {
      name: "e2e null nodeTimeout default SLA",
      nodes: [{ id: "solo", kind: "agent", agent: { jobType: "never-registered-so-it-parks" } }],
      edges: [],
    };

    // Run-level SLA PT2S → `runNodeTimeout`. Null the per-node timeout to drive the fallback path.
    const prep = await prepareDeliveryGraph(graph, { nodeTimeout: "PT2S", repoless: true });
    assert.ok(prep.ok, `prepare should succeed, got ${JSON.stringify(prep)}`);
    const { processDefinitionId, bpmn, nodeInputs, runKey, runNodeTimeout } = prep.prepared;
    const agentElement = Object.keys(nodeInputs).find((el) => "jobType" in (nodeInputs[el] as Record<string, unknown>));
    assert.ok(agentElement, "the agent node's element input exists");
    (nodeInputs[agentElement] as Record<string, unknown>).timeout = null;

    await app.engine.deployResources([{ name: `${processDefinitionId}.bpmn`, content: bpmn, contentType: "application/xml" }]);
    await app.engine.createInstance({ processDefinitionId, variables: { nodeInputs, runKey, runNodeTimeout } });
    // The agent job type is never registered, so the node parks on its service task awaiting the timer.
    await app.settle();

    // A null per-node timeout must NOT fire a zero-length timer: with the fallback the SLA is PT2S, so
    // no escalation yet. (Pre-fix, the `=nodeTimeout` null duration fires here during settle.)
    assert.ok(
      (await app.engine.searchUserTasks({ state: "CREATED" })).every((t) => !t.elementId?.endsWith("__esc")),
      "a null per-node timeout must fall back to the default SLA, NOT fire the boundary instantly",
    );

    // Elapse the fallback SLA → the boundary fires exactly as a real PT2S timer would.
    await app.advanceTime(2_100);
    const esc = (await app.engine.searchUserTasks({ state: "CREATED" })).filter((t) => t.elementId?.endsWith("__esc"));
    assert.ok(esc.length >= 1, `the fallback SLA eventually escalates the parked node, got ${JSON.stringify((await app.engine.searchUserTasks({ state: "CREATED" })).map((t) => t.elementId))}`);
  });
});
