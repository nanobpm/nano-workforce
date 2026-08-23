// End-to-end proof for the inter-epic capability PREFLIGHT seeded into plan-fanout (issue #292, slice
// S3). Boots the whole app against the WASM engine + virtual clock and drives the REAL
// `plan-fanout.bpmn` with `readinessProbes` seeded — the exact shape slice S3's lowering seeds for a
// DEPENDENT epic — proving the leading readiness-gate executes on the engine BEFORE wave 0:
//   • GREEN — a dependent seeded with a probe that is ready reruns the reused `pr.readiness-probe`
//     worker inside the multi-instance preflight, releases through `pf_gw → pf_end`, binds the
//     resolved artifact into `resolvedArtifacts`, and only THEN reaches `ensure-base-branch` (the
//     head of the fan-out) — it never fans a wave before the gate is green, and never escalates.
//   • ROOT — an epic seeded with `readinessProbes = null` skips the gate entirely
//     (`gw-readiness → ensure-base-branch`), fanning out immediately as a single epic does today.
//
// The probe is a deterministic shell builtin (`true`) with a bound artifact, so the gate itself is
// hermetic (no network, no GitHub). The fan-out head (`pr.ensure-base-branch`) that follows a green
// gate is handled by the shared hermetic admit-github stub (installAdmitGithub) like the sibling
// plan-fanout e2es, so the whole flow runs offline.
// We assert on the cumulative taken sequence flows (the WASM engine folds completed variables away).
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

// The full variable set `startPlan` seeds onto a plan-fanout instance (app/plan.ts). We seed it
// directly so we can inject `readinessProbes` (which the `startPlanFanout` op never sets — only S3's
// set lowering does) without standing up a whole two-epic set + release provenance.
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

async function boot(): Promise<{ app: TestApp; dbDir: string }> {
  const dbDir = mkdtempSync(join(tmpdir(), "nwf-preflight-"));
  const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dbDir, "app.db")}` } });
  return { app, dbDir };
}

describe("plan-fanout inter-epic capability preflight (plan-fanout.bpmn, issue #292 S3)", () => {
  let restoreGithub: (() => void) | undefined;
  const probeSeam = deterministicProbeSeam("plan-fanout-preflight e2e");

  before(() => {
    for (const [k, v] of Object.entries(GITHUB_ENV_OVERRIDES)) {
      savedEnv.set(k, process.env[k]);
      process.env[k] = v;
    }
    // Inject the deterministic probe exec so the `command: true` probe resolves WITHIN the virtual
    // clock's drain fixpoint instead of spawning a real subprocess whose wall-clock completion
    // `settle()` cannot await — the flake behind this suite (issue #450).
    probeSeam.install();
    // The fan-out head (`pr.ensure-base-branch`, ADR 0003) reads/creates the base ref via the token
    // transport, which would throw `no GitHub transport available` under an empty token. Pin the
    // shared hermetic admit-github stub (dummy token + fetch intercept) like the sibling plan-fanout
    // e2es so base-branch admission is deterministic and offline.
    restoreGithub = installAdmitGithub(admitGithubState("owner/repo", "main"));
  });
  after(() => {
    restoreGithub?.();
    probeSeam.restoreAndAssertHermetic();
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("GREEN: a dependent waits on the preflight, releases green, and only THEN reaches the fan-out head", async () => {
    const { app, dbDir } = await boot();
    try {
      const { processInstanceKey } = await app.engine.createInstance({
        processDefinitionId: "plan-fanout",
        variables: planVars({
          // The shape S3 lowering seeds — here a hermetic green probe that binds a version, standing
          // in for the `capability` probe (whose green/bind path is unit-tested in planLowering.test).
          readinessProbes: [
            {
              kind: "command",
              target: "true",
              resolvedArtifact: "@scope/pkg@1.4.0",
              poll: { everyMs: 5, timeoutMs: 5000, backoff: "fixed" },
            },
          ],
          probeTimeout: "PT30M",
          probePollEvery: "PT15S",
          gateKey: "preflight:owner/repo#2",
        }),
      });
      await app.settle();

      const flows = takenFlows(app);
      // The DEPENDENT was gated: it entered the preflight (not the root skip) and released green.
      assert.ok(
        flows.includes("gw-readiness->readiness-preflight"),
        `a dependent enters the preflight (flows: ${flows.join(", ")})`,
      );
      assert.ok(flows.includes("pf_gw->pf_end"), "the probe went green and settled the gate");
      // Only AFTER the gate does it reach ensure-base-branch — the head of the fan-out (wave 0 is
      // downstream of it). The gate is a true PREFLIGHT, not a parallel afterthought.
      assert.ok(
        flows.includes("readiness-preflight->ensure-base-branch"),
        "the green gate leads into the fan-out head",
      );
      // A green probe never escalates.
      const tasks = await app.engine.searchUserTasks({ processInstanceKey });
      assert.equal(
        tasks.filter((t) => t.elementId === "readiness-escalation-pf").length,
        0,
        "a green preflight never opens an escalation task",
      );
    } finally {
      await app.stop();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  test("ROOT: readinessProbes = null skips the gate and fans out immediately", async () => {
    const { app, dbDir } = await boot();
    try {
      await app.engine.createInstance({
        processDefinitionId: "plan-fanout",
        variables: planVars({ planKey: "owner/repo#1", issue: "owner/repo#1", readinessProbes: null }),
      });
      await app.settle();

      const flows = takenFlows(app);
      assert.ok(
        flows.includes("gw-readiness->ensure-base-branch"),
        `a root skips straight to the fan-out head (flows: ${flows.join(", ")})`,
      );
      assert.ok(!flows.includes("gw-readiness->readiness-preflight"), "a root never enters the preflight");
    } finally {
      await app.stop();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
