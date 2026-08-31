// End-to-end proof for the intake-time readiness gate seeded into a single-issue feature run
// (issue #295). Boots the whole app against the WASM engine + virtual clock and drives the REAL
// `feature.bpmn` with `readinessProbes` seeded — the exact shape `startFeature` seeds for a gated
// submission — proving the leading readiness-preflight executes on the engine BEFORE the fan-out
// head (`ensure-base-branch`) and the implement agent:
//   • GATED — a feature seeded with a probe that is ready runs the reused `pr.readiness-probe`
//     worker inside the multi-instance preflight, releases through `pf_gw → pf_end`, and only THEN
//     reaches `ensure-base-branch` and `implement-task` — it never implements before the gate is
//     green, and never escalates.
//   • UNGATED — a feature seeded with `readinessProbes = null` skips the gate entirely
//     (`gw-readiness → ensure-base-branch`), implementing immediately as today's ungated features do.
//
// The probe is a deterministic shell builtin (`true`) with a bound artifact, so the gate itself is
// hermetic (no network, no GitHub). The fan-out head (`pr.ensure-base-branch`) that follows a green
// gate is handled by the shared hermetic admit-github stub (installAdmitGithub) like the sibling
// preflight e2e, so the whole flow runs offline. The implement agent (`senior:feature`) has no
// worker registered here, so the instance simply parks on `implement-task` after the gate — we
// assert on the cumulative taken sequence flows (the WASM engine folds completed variables away).
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

// The full variable set `startFeature` seeds onto a feature instance (app/feature.ts). We seed it
// directly so we can inject `readinessProbes` (and the derived `probeTimeout`/`gateKey`) without
// standing up a whole upstream-dependency set. `baseBranch` is the admit-github default branch, so
// the fan-out head reads it without creating a ref.
function featureVars(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    featureKey: "owner/repo#7",
    repo: "owner/repo",
    issue: "owner/repo#7",
    issueNumber: 7,
    issueUrl: "https://github.com/owner/repo/issues/7",
    task: {
      id: "issue-7",
      title: "owner/repo#7",
      prompt: "Implement the GitHub issue owner/repo#7 end to end.",
    },
    converge: true,
    autoMerge: false,
    claimIssue: true,
    answer: null,
    status: null,
    question: null,
    summary: null,
    pr: null,
    escalationSlaTimeout: "PT24H",
    escalationAssignee: null,
    baseBranch: "main",
    baseBranchBrief: "",
    customInstructions: null,
    readinessProbes: null,
    probeTimeout: null,
    probePollEvery: null,
    gateKey: null,
    resolvedArtifacts: null,
    ...overrides,
  };
}

async function boot(): Promise<{ app: TestApp; dbDir: string }> {
  const dbDir = mkdtempSync(join(tmpdir(), "nwf-feature-preflight-"));
  const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dbDir, "app.db")}` } });
  return { app, dbDir };
}

describe("single-issue feature intake readiness gate (feature.bpmn, issue #295)", () => {
  let restoreGithub: (() => void) | undefined;
  const probeSeam = deterministicProbeSeam("feature-preflight e2e");

  before(() => {
    for (const [k, v] of Object.entries(GITHUB_ENV_OVERRIDES)) {
      savedEnv.set(k, process.env[k]);
      process.env[k] = v;
    }
    // Inject the deterministic probe exec so the `command: true` probe resolves WITHIN the virtual
    // clock's drain fixpoint instead of spawning a real subprocess whose wall-clock completion
    // `settle()` cannot await — the flake behind this suite (issue #450).
    probeSeam.install();
    // `pr.ensure-base-branch` reads the base ref via the token transport, which would throw
    // `no GitHub transport available` under an empty token. Pin the shared hermetic admit-github
    // stub (dummy token + fetch intercept) like the sibling preflight e2e so base-branch admission
    // is deterministic and offline.
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

  test("GATED: a feature with a green probe parks on the preflight, releases green, and only THEN implements", async () => {
    const { app, dbDir } = await boot();
    try {
      const { processInstanceKey } = await app.engine.createInstance({
        processDefinitionId: "feature",
        variables: featureVars({
          // The shape `startFeature` seeds for a gated submission — here a hermetic green probe that
          // binds a version, standing in for the `capability` probe (whose green/bind path is
          // unit-tested in featureReadiness.test).
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
          gateKey: "feature-readiness:owner/repo#7",
        }),
      });
      await app.settle();

      const flows = takenFlows(app);
      // The feature was gated: it entered the preflight (not the ungated skip) and released green.
      assert.ok(
        flows.includes("gw-readiness->readiness-preflight"),
        `a gated feature enters the preflight (flows: ${flows.join(", ")})`,
      );
      assert.ok(flows.includes("pf_gw->pf_end"), "the probe went green and settled the preflight");
      // Only AFTER the gate does it reach ensure-base-branch and then implement-task — the gate is a
      // true PREFLIGHT, not a parallel afterthought.
      assert.ok(
        flows.includes("readiness-preflight->ensure-base-branch"),
        "the green gate leads into the fan-out head",
      );
      assert.ok(
        flows.includes("ensure-base-branch->record-feature-implementing") &&
          flows.includes("record-feature-implementing->implement-task"),
        `the run reaches the implement agent only after the gate (flows: ${flows.join(", ")})`,
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

  test("UNGATED: readinessProbes = null skips the gate and implements immediately", async () => {
    const { app, dbDir } = await boot();
    try {
      await app.engine.createInstance({
        processDefinitionId: "feature",
        variables: featureVars({ featureKey: "owner/repo#8", issue: "owner/repo#8", readinessProbes: null }),
      });
      await app.settle();

      const flows = takenFlows(app);
      assert.ok(
        flows.includes("gw-readiness->ensure-base-branch"),
        `an ungated feature skips straight to the fan-out head (flows: ${flows.join(", ")})`,
      );
      assert.ok(!flows.includes("gw-readiness->readiness-preflight"), "an ungated feature never enters the preflight");
      assert.ok(
        flows.includes("record-feature-implementing->implement-task"),
        "an ungated feature reaches the implement agent",
      );
    } finally {
      await app.stop();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
