// End-to-end proof for the durable artifact-readiness wait-gate (ADR 0001 §2, issue #258).
//
// Boots this whole Urban app in-process against the WASM engine + virtual clock via `bootTestApp`
// and drives the real `readiness-gate` process — the reusable primitive: a parallel fork arms the
// `pr.readiness-probe` service task (an app-hosted worker) alongside an event-based gateway that
// races the `readiness-ready` message the probe publishes against a bounded timer catch.
//
// Two load-bearing behaviours are proven end to end:
//   • READY — a `command` probe that is green immediately (`true`) drives the probe worker to
//     publish `readiness-ready`, the gateway correlates it, and the gate releases through
//     `wait-ready → gate-ready`.
//   • BOUNDED (the red-first "the wait cannot hang" gate) — a `command` probe that is never green
//     (`false`) exhausts the worker's local budget WITHOUT publishing; the wait does not hang, and
//     when the engine timer (the authoritative bound) fires it escalates onto the native
//     `readiness-escalation` userTask. A gate modelled without the timer arm could never satisfy
//     this — the token would sit on `wait-ready` forever.
//
// The probes are deterministic shell builtins (`true`/`false`) so the flow is hermetic — no
// network, no GitHub. GitHub transport is still forced offline to match the sibling e2es.
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";
import type { CommandResult, ProbeExec } from "../app/readiness.ts";
import { __setProbeExecForTest } from "../workers/readiness-probe/worker.ts";

// A synchronous, in-memory ProbeExec so the probe resolves WITHIN the testkit's virtual-clock drain
// fixpoint instead of spawning a REAL subprocess (real-time work `settle()` cannot deterministically
// await — issue #450). It maps the hermetic shell builtins these scenarios use to a deterministic
// `CommandResult` — `true` → exit 0 (green), `false` → exit 1 (never green) — mirroring the real
// commands' semantics exactly, but with zero real time. `httpGet` throws: these gate-flow scenarios
// use only `command` probes, so any HTTP call would be an unintended real-network escape.
const deterministicExec: ProbeExec = {
  run(command: string): Promise<CommandResult> {
    const cmd = command.trim();
    const code = cmd === "true" ? 0 : cmd === "false" ? 1 : 127;
    return Promise.resolve({ code, stdout: "", stderr: "" });
  },
  httpGet(): Promise<never> {
    return Promise.reject(new Error(`readiness-gate e2e: unexpected real HTTP probe (command probes only)`));
  },
};

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let dbSeq = 0;

const GITHUB_ENV_OVERRIDES: Record<string, string> = {
  NANO_PR_GITHUB_TRANSPORT: "token",
  GITHUB_TOKEN: "",
};
const savedEnv = new Map<string, string | undefined>();

interface TakenFlow {
  from: string;
  to: string;
}

function takenFlows(app: TestApp): string[] {
  const snapshot = app.snapshot();
  const flows = Array.isArray(snapshot.takenSequenceFlows) ? snapshot.takenSequenceFlows : [];
  return flows
    .filter((f): f is TakenFlow => typeof f === "object" && f !== null && "from" in f && "to" in f)
    .map((f) => `${f.from}->${f.to}`);
}

// Each scenario boots its own app so `takenSequenceFlows` (engine-global + cumulative) reflects
// exactly one instance's history.
async function boot(): Promise<{ app: TestApp; dbDir: string }> {
  const dbDir = join(APP_ROOT, ".test-artifacts", `nwf-readiness-${process.pid}-${dbSeq++}`);
  mkdirSync(dbDir, { recursive: true });
  const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dbDir, "app.db")}` } });
  return { app, dbDir };
}

describe("nano-workforce artifact-readiness wait-gate (readiness-gate.bpmn)", () => {
  before(() => {
    for (const [k, v] of Object.entries(GITHUB_ENV_OVERRIDES)) {
      savedEnv.set(k, process.env[k]);
      process.env[k] = v;
    }
    // Inject the deterministic exec so the probe never spawns a real subprocess under the virtual
    // clock (issue #450). Scenario-agnostic: it maps each scenario's command by string.
    __setProbeExecForTest(deterministicExec);
  });

  after(() => {
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // Restore production exec — the seam must never outlive this suite.
    __setProbeExecForTest(undefined);
  });

  test("READY: a green probe publishes readiness-ready and the gate releases through wait-ready → gate-ready", async () => {
    const { app, dbDir } = await boot();
    try {
      await app.engine.createInstance({
        processDefinitionId: "readiness-gate",
        variables: {
          gateKey: "gate-ready-1",
          probe: { kind: "command", target: "true", poll: { everyMs: 5, timeoutMs: 5000, backoff: "fixed" } },
          // A long engine timer that must NOT fire — readiness wins the race first.
          probeTimeout: "PT30M",
          probePollEvery: "PT15S",
          onTimeout: "escalate",
        },
      });
      await app.settle();

      const flows = takenFlows(app);
      assert.ok(
        flows.includes("wait-ready->gate-ready"),
        `the gate released on the readiness signal (flows: ${flows.join(", ")})`,
      );
      assert.ok(
        flows.includes("probe-loop->probe-done"),
        "the probe loop branch settled after publishing the readiness signal",
      );
      // The gate never timed out — no escalation userTask exists.
      const tasks = await app.engine.searchUserTasks({});
      assert.equal(
        tasks.filter((t) => t.elementId === "readiness-escalation").length,
        0,
        "a probe that went green never escalates",
      );
    } finally {
      await app.stop();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  test("BOUNDED: a never-green probe cannot hang — the engine timer fires and escalates onto the userTask", async () => {
    const { app, dbDir } = await boot();
    try {
      const { processInstanceKey } = await app.engine.createInstance({
        processDefinitionId: "readiness-gate",
        variables: {
          gateKey: "gate-timeout-1",
          // `false` is never ready; a tiny local budget makes the worker exhaust fast (real time),
          // leaving the ENGINE timer as the authoritative bound.
          probe: { kind: "command", target: "false", poll: { everyMs: 15_000, timeoutMs: 60_000, backoff: "fixed" } },
          probeTimeout: "PT1M",
          probePollEvery: "PT15S",
          onTimeout: "escalate",
        },
      });
      await app.settle();

      // The wait has NOT hung and has NOT yet escalated: the first single-shot probe returned not-ready,
      // and the retry cadence is parked on the engine-owned poll timer.
      const beforeTimer = await app.engine.searchUserTasks({ processInstanceKey });
      assert.equal(
        beforeTimer.filter((t) => t.elementId === "readiness-escalation").length,
        0,
        "the gate is still bounded-waiting on the timer, not prematurely escalated",
      );
      const beforeFlows = takenFlows(app);
      assert.ok(!beforeFlows.includes("wait-ready->gate-ready"), "a never-green probe never releases as ready");

      await app.advanceTime(15_000);
      const afterPoll = takenFlows(app);
      assert.ok(afterPoll.includes("wait-poll->probe"), "the engine timer, not a worker sleep loop, schedules the next probe");
      assert.equal(
        (await app.engine.searchUserTasks({ processInstanceKey })).filter((t) => t.elementId === "readiness-escalation").length,
        0,
        "one poll interval only re-probes; it does not consume the timeout",
      );

      // Advancing past the engine timer is the ONLY thing that ends the wait. The timeout arm routes
      // through one last empirical probe before the event-based gateway timer opens escalation.
      await app.advanceTime(46_000);

      const afterFlows = takenFlows(app);
      assert.ok(
        afterFlows.includes("wait-timeout->gw-onTimeout") && afterFlows.includes("gw-onTimeout->readiness-escalation"),
        `the timer bounded the wait and routed to escalation (flows: ${afterFlows.join(", ")})`,
      );
      const escalations = (await app.engine.searchUserTasks({ processInstanceKey })).filter(
        (t) => t.elementId === "readiness-escalation",
      );
      assert.equal(escalations.length, 1, "the bounded timeout opened exactly one escalation userTask");

      // Completing the escalation with `acknowledge` releases the gate to its `escalated` terminal
      // via the resolution gateway (default arm) — the primitive is fully durable.
      await app.engine.completeUserTask(escalations[0].userTaskKey, { resolution: "acknowledge" });
      await app.settle();
      const ackFlows = takenFlows(app);
      assert.ok(
        ackFlows.includes("readiness-escalation->gw-resolution") && ackFlows.includes("gw-resolution->gate-escalated"),
        "acknowledging the escalation routes through the resolution gateway to gate-escalated",
      );
    } finally {
      await app.stop();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  test("ABANDON: an operator who abandons the escalation drives the gate to its `failed` terminal, not `escalated`", async () => {
    const { app, dbDir } = await boot();
    try {
      const { processInstanceKey } = await app.engine.createInstance({
        processDefinitionId: "readiness-gate",
        variables: {
          gateKey: "gate-abandon-1",
          probe: { kind: "command", target: "false", poll: { everyMs: 5, timeoutMs: 40, backoff: "fixed" } },
          probeTimeout: "PT1M",
          probePollEvery: "PT15S",
          onTimeout: "escalate",
        },
      });
      await app.settle();
      await app.advanceTime(61_000);

      const escalations = (await app.engine.searchUserTasks({ processInstanceKey })).filter(
        (t) => t.elementId === "readiness-escalation",
      );
      assert.equal(escalations.length, 1, "the bounded timeout opened exactly one escalation userTask");

      // `abandon` ("give up on this gate") must NOT be a no-op: it routes to gate-failed, not gate-escalated.
      await app.engine.completeUserTask(escalations[0].userTaskKey, { resolution: "abandon" });
      await app.settle();
      const flows = takenFlows(app);
      assert.ok(
        flows.includes("gw-resolution->gate-failed"),
        `abandoning the escalation routes to gate-failed (flows: ${flows.join(", ")})`,
      );
      assert.ok(
        !flows.includes("gw-resolution->gate-escalated"),
        "abandon must not reach the escalated terminal",
      );
    } finally {
      await app.stop();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  test("onTimeout=continue: a bounded timeout proceeds (no escalation) when the caller declares continue", async () => {
    const { app, dbDir } = await boot();
    try {
      await app.engine.createInstance({
        processDefinitionId: "readiness-gate",
        variables: {
          gateKey: "gate-continue-1",
          probe: { kind: "command", target: "false", poll: { everyMs: 5, timeoutMs: 40, backoff: "fixed" } },
          probeTimeout: "PT1M",
          probePollEvery: "PT15S",
          onTimeout: "continue",
        },
      });
      await app.settle();
      await app.advanceTime(61_000);

      const flows = takenFlows(app);
      assert.ok(
        flows.includes("gw-onTimeout->gate-continued"),
        `a continue-on-timeout gate proceeds past the bounded wait (flows: ${flows.join(", ")})`,
      );
    } finally {
      await app.stop();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  test("DEFAULT SAFETY: an omitted onTimeout escalates (the gateway default is the safety path, not continue)", async () => {
    const { app, dbDir } = await boot();
    try {
      await app.engine.createInstance({
        processDefinitionId: "readiness-gate",
        variables: {
          gateKey: "gate-default-1",
          // Neither probe.onTimeout nor a top-level onTimeout is declared.
          probe: { kind: "command", target: "false", poll: { everyMs: 5, timeoutMs: 40, backoff: "fixed" } },
          probeTimeout: "PT1M",
          probePollEvery: "PT15S",
        },
      });
      await app.settle();
      await app.advanceTime(61_000);

      const flows = takenFlows(app);
      assert.ok(
        flows.includes("gw-onTimeout->readiness-escalation"),
        `an omitted onTimeout must default to escalation, never silently continue (flows: ${flows.join(", ")})`,
      );
      assert.ok(
        !flows.includes("gw-onTimeout->gate-continued"),
        "the safety default must not route to continue",
      );
    } finally {
      await app.stop();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  test("probe.onTimeout wins: the descriptor field is preferred over a top-level onTimeout (one source of truth)", async () => {
    const { app, dbDir } = await boot();
    try {
      await app.engine.createInstance({
        processDefinitionId: "readiness-gate",
        variables: {
          gateKey: "gate-probe-pref-1",
          // The descriptor asks to continue; a stale top-level onTimeout says escalate. probe wins.
          probe: { kind: "command", target: "false", onTimeout: "continue", poll: { everyMs: 5, timeoutMs: 40, backoff: "fixed" } },
          probeTimeout: "PT1M",
          probePollEvery: "PT15S",
          onTimeout: "escalate",
        },
      });
      await app.settle();
      await app.advanceTime(61_000);

      const flows = takenFlows(app);
      assert.ok(
        flows.includes("gw-onTimeout->gate-continued"),
        `probe.onTimeout ("continue") must win over the top-level onTimeout ("escalate") (flows: ${flows.join(", ")})`,
      );
    } finally {
      await app.stop();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
