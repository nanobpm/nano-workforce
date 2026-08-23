// Adversarial end-to-end proof for the inter-epic capability gate on the REAL `plan-fanout.bpmn`
// (issue #292, slice S5). The sibling e2e (plan-fanout-preflight.e2e.ts) proves the GREEN and ROOT
// paths; this suite proves the RED, adversarial ones the whole feature hinges on — driven on the
// engine + virtual clock via `bootTestApp`, hermetic (a deterministic shell-builtin probe, no
// network, no GitHub):
//
//   • S5 P1 — HOLDS WAVE 0: a dependent whose producer never publishes parks at the preflight and
//     NEVER reaches `ensure-base-branch` (the head of the fan-out). The gate is a true barrier.
//   • S5 P3 — ESCALATES, then DOESN'T WEDGE: the never-green probe opens exactly one
//     `readiness-escalation-pf` user task; an operator who acknowledges it releases the gate onward
//     to the fan-out head — the stall is surfaced and recoverable, not a silent dead end.
//   • S5 P7 — NEVER HANGS FOREVER: with NO human acting, the escalation's bounded SLA timer
//     (`be_pf_sla`) fires and auto-abandons the gate onward — a removed/never-finishing producer can
//     never strand the dependent indefinitely.
//
// We assert on the cumulative taken sequence flows (the WASM engine folds completed variables away),
// exactly like the sibling plan-fanout e2es.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";
import { admitGithubState, installAdmitGithub } from "./support/github-admit.ts";
import { deterministicProbeSeam } from "./support/probe-exec.ts";

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

// The full variable set `startPlan` seeds onto a plan-fanout instance (mirrors
// plan-fanout-preflight.e2e.ts). We inject `readinessProbes` directly — the shape S3's set lowering
// seeds for a DEPENDENT — so we can drive the gate without standing up a whole two-epic set.
function planVars(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    planKey: "owner/repo#2",
    repo: "owner/repo",
    issue: "owner/repo#2",
    issueNumber: 2,
    issueUrl: "https://github.com/owner/repo/issues/2",
    planFindings: null,
    planReviewEpoch: 0,
    escalationSlaTimeout: "PT24H",
    escalationAssignee: null,
    blackboardUrl: "http://blackboard.local/x",
    blackboardBrief: "",
    baseBranch: "epic/e2e",
    baseBranchBrief: "",
    waveCount: 1,
    readinessProbes: null,
    probeTimeout: null,
    probePollEvery: null,
    gateKey: null,
    resolvedArtifacts: null,
    ...overrides,
  };
}

// A never-green probe: `false` is never ready. The worker's local poll budget is the seeded
// `probeTimeout` (in real time), so a SHORT `probeTimeout` (PT2S below) makes the worker exhaust its
// budget quickly and settle NOT-ready — the gateway's default `pf_escalate` arm then fires, parking
// the gate on the escalation user task (P1/P3) until either a human or the SLA timer (P7) resolves it.
function redProbe(): Record<string, unknown> {
  return { kind: "command", target: "false", poll: { everyMs: 5, backoff: "fixed" } };
}

async function boot(): Promise<{ app: TestApp; dbDir: string }> {
  const dbDir = mkdtempSync(join(tmpdir(), "nwf-s5-interepic-"));
  const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dbDir, "app.db")}` } });
  return { app, dbDir };
}

describe("inter-epic capability gate — adversarial (plan-fanout.bpmn, issue #292 S5)", () => {
  let restoreGithub: (() => void) | undefined;
  // The adversarial gates poll `command: false` (never-green) probes through the readiness-probe
  // worker; inject the deterministic exec so each poll resolves inside the virtual clock's drain
  // fixpoint (the escalation/timeout path is driven by engine-clock advancement, not a real
  // subprocess) — issue #450.
  const probeSeam = deterministicProbeSeam("inter-epic adversarial e2e");

  before(() => {
    probeSeam.install();
    for (const [k, v] of Object.entries(GITHUB_ENV_OVERRIDES)) {
      savedEnv.set(k, process.env[k]);
      process.env[k] = v;
    }
    // The fan-out head (`pr.ensure-base-branch`) reads/creates the base ref via the token transport;
    // pin the shared hermetic admit-github stub so a released gate reaches it offline.
    restoreGithub = installAdmitGithub(admitGithubState("owner/repo", "main"));
  });
  after(() => {
    restoreGithub?.();
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    probeSeam.restoreAndAssertHermetic();
  });

  // ── S5 P1 — the gate HOLDS wave 0 ───────────────────────────────────────────────────────────────
  test("S5 P1: a dependent whose producer never publishes parks at the preflight and never reaches the fan-out head", async () => {
    const { app, dbDir } = await boot();
    try {
      const { processInstanceKey } = await app.engine.createInstance({
        processDefinitionId: "plan-fanout",
        variables: planVars({
          readinessProbes: [redProbe()],
          probeTimeout: "PT2S",
          probePollEvery: "PT1S",
          gateKey: "preflight:owner/repo#2",
        }),
      });
      await app.settle();

      const flows = takenFlows(app);
      // It entered the gate (it is a dependent, not a root skip)…
      assert.ok(
        flows.includes("gw-readiness->readiness-preflight"),
        `the dependent enters the preflight (flows: ${flows.join(", ")})`,
      );
      // …the probe went NOT-ready, so the gate never released as ready…
      assert.ok(!flows.includes("pf_gw->pf_end"), "a never-green probe never releases the gate as ready");
      // …and CRUCIALLY it never fanned out: the head of the fan-out was never reached.
      assert.ok(
        !flows.includes("readiness-preflight->ensure-base-branch"),
        "the gate HOLDS wave 0 — a parked dependent never reaches the fan-out head",
      );
      await app.advanceTime(2_100);
      // The token is parked on the escalation user task after the engine-owned timeout, not lost.
      const tasks = (await app.engine.searchUserTasks({ processInstanceKey })).filter(
        (t) => t.elementId === "readiness-escalation-pf",
      );
      assert.equal(tasks.length, 1, "the held gate surfaces as exactly one escalation task, not a silent stall");
    } finally {
      await app.stop();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  // ── S5 P3 — it ESCALATES, and an operator ack un-wedges it ───────────────────────────────────────
  test("S5 P3: the never-green gate escalates exactly once, and acknowledging it releases the fan-out (no wedge)", async () => {
    const { app, dbDir } = await boot();
    try {
      const { processInstanceKey } = await app.engine.createInstance({
        processDefinitionId: "plan-fanout",
        variables: planVars({
          readinessProbes: [redProbe()],
          probeTimeout: "PT2S",
          probePollEvery: "PT1S",
          gateKey: "preflight:owner/repo#2",
        }),
      });
      await app.settle();
      await app.advanceTime(2_100);

      const escalations = (await app.engine.searchUserTasks({ processInstanceKey })).filter(
        (t) => t.elementId === "readiness-escalation-pf",
      );
      assert.equal(escalations.length, 1, "a never-publishing producer escalates exactly once (bounded, not a storm)");

      // An operator acknowledges the stall — the gate must NOT wedge: it proceeds onward to the fan-out.
      await app.engine.completeUserTask(escalations[0].userTaskKey, { resolution: "acknowledge" });
      await app.settle();

      const flows = takenFlows(app);
      assert.ok(
        flows.includes("readiness-escalation-pf->pf_gw_res") && flows.includes("pf_gw_res->pf_end"),
        `acknowledging routes through the resolution gateway to settle the gate (flows: ${flows.join(", ")})`,
      );
      assert.ok(
        flows.includes("readiness-preflight->ensure-base-branch"),
        "an acknowledged gate is NOT wedged — it releases onward to the fan-out head",
      );
    } finally {
      await app.stop();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  // ── S5 P7 — the SLA timer means it NEVER hangs forever, even with no human ────────────────────────
  test("S5 P7: with no operator acting, the escalation's bounded SLA auto-abandons onward — the gate never hangs forever", async () => {
    const { app, dbDir } = await boot();
    try {
      const { processInstanceKey } = await app.engine.createInstance({
        processDefinitionId: "plan-fanout",
        variables: planVars({
          readinessProbes: [redProbe()],
          probeTimeout: "PT2S",
          escalationSlaTimeout: "PT1H",
          gateKey: "preflight:owner/repo#2",
        }),
      });
      await app.settle();
      await app.advanceTime(2_100);

      // Parked on the escalation, no human acts. Before the SLA it has NOT proceeded.
      const before = takenFlows(app);
      assert.ok(!before.includes("be_pf_sla->pf_end"), "the SLA has not yet fired");
      assert.ok(
        !before.includes("readiness-preflight->ensure-base-branch"),
        "the gate is still held before the SLA elapses",
      );

      // Advancing past the escalation SLA is the ONLY thing that ends the unattended wait — proving the
      // bound is engine-owned. It auto-abandons the gate ONWARD (never strands the dependent forever).
      await app.advanceTime(61 * 60 * 1000);
      await app.settle();

      const after = takenFlows(app);
      assert.ok(
        after.includes("be_pf_sla->pf_end"),
        `the bounded SLA timer fires and settles the held gate (flows: ${after.join(", ")})`,
      );
      assert.ok(
        after.includes("readiness-preflight->ensure-base-branch"),
        "the auto-abandoned gate releases onward — the dependent is never stranded indefinitely",
      );
    } finally {
      await app.stop();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
