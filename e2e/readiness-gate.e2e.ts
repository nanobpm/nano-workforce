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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
  const dbDir = mkdtempSync(join(tmpdir(), "nwf-readiness-"));
  const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dbDir, "app.db")}` } });
  return { app, dbDir };
}

describe("nano-workforce artifact-readiness wait-gate (readiness-gate.bpmn)", () => {
  before(() => {
    for (const [k, v] of Object.entries(GITHUB_ENV_OVERRIDES)) {
      savedEnv.set(k, process.env[k]);
      process.env[k] = v;
    }
  });

  after(() => {
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
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
        flows.includes("probe->probe-done"),
        "the probe branch settled after publishing the readiness signal",
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
          probe: { kind: "command", target: "false", poll: { everyMs: 5, timeoutMs: 40, backoff: "fixed" } },
          probeTimeout: "PT1M",
          onTimeout: "escalate",
        },
      });
      await app.settle();

      // The wait has NOT hung and has NOT yet escalated: the probe branch settled not-ready, and the
      // gate is parked on the timer catch — no escalation userTask before the timer's duration.
      const beforeTimer = await app.engine.searchUserTasks({ processInstanceKey });
      assert.equal(
        beforeTimer.filter((t) => t.elementId === "readiness-escalation").length,
        0,
        "the gate is still bounded-waiting on the timer, not prematurely escalated",
      );
      const beforeFlows = takenFlows(app);
      assert.ok(!beforeFlows.includes("wait-ready->gate-ready"), "a never-green probe never releases as ready");

      // Advancing past the engine timer is the ONLY thing that ends the wait — proving the bound is
      // engine-owned. The token races off the timer catch onto the escalation userTask.
      await app.advanceTime(61_000);

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
