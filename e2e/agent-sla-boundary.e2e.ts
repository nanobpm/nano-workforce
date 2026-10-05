// End-to-end runtime proof for the AGENT-task liveness SLA boundary (issue #849, review round 2).
// The structural guard (`app/agentic/vocab/agent-sla-boundary.test.ts`) only proves every bounded
// external agent task CARRIES an interrupting timer boundary — it does not exercise the runtime
// behaviour. This suite boots the whole app against the WASM engine + virtual clock, parks the
// implementation agent (a hung/looping agent that never completes its job), advances the engine
// clock past the seeded `agentSlaTimeout` (PT2H), and asserts the token took the boundary's
// escalation arm — the durable in-process liveness the slice lands.
//
// Scope: the implement-cell's `implement-task`, driven through BOTH of its real parent call
// activities — a standalone `feature` run and a plan-fanout wave slice — so the parent→child
// `agentSlaTimeout` scope propagation added this round (the explicit callActivity input mapping) is
// covered, not just the boundary's existence. A too-short advance (under PT2H) leaves the agent
// parked and the escalation task absent; the full advance fires `be_implement_sla`, routes through
// `record-escalation-sla` (which synthesises the SLA question), and parks the shared
// `human-escalation` cell's `escalation` user task.
//
// The boundary path is the falsifiable core: the WASM engine folds a completed instance's variables
// away, so we assert on the cumulative taken sequence flows. A hung agent with NO SLA boundary would
// simply park forever — never taking `ic_sla` — so a green here proves the bound is real. Each
// scenario boots its own app so `takenSequenceFlows` (engine-global, cumulative) reflects exactly one
// instance's routing.
//
// Run with `npm run e2e`.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";
import { admitGithubState, installAdmitGithub } from "./support/github-admit.ts";
import { advancePastTimer, settleFully } from "./support/time.ts";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const GITHUB_ENV_OVERRIDES: Record<string, string> = {
  NANO_PR_GITHUB_TRANSPORT: "token",
  GITHUB_TOKEN: "",
};

// The canonical agent SLA is PT2H (app/agentSla.ts DEFAULT_AGENT_SLA_TIMEOUT). Advance just past it
// so the AGENT boundary fires but the downstream human-escalation SLA (PT24H) does NOT — isolating
// the agent-SLA arm. The short advance (under PT2H) proves the boundary is genuinely armed on the
// seeded duration, not firing spuriously.
const PAST_AGENT_SLA_MS = 3 * 60 * 60 * 1000; // 3h > PT2H
const UNDER_AGENT_SLA_MS = 30 * 60 * 1000; // 30m < PT2H

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

/** Park the implementation agent: a mock with a single never-matching clause resolves to
 *  `undefined`, so the dispatch falls through and (with no real `senior:*` handler registered) the
 *  job stays locked — the deterministic stand-in for a hung/looping agent that never completes. */
function parkAgent(app: TestApp, jobType: string): void {
  app.engine.mockWorker(jobType).when(() => false).completeWith({});
}

async function openEscalationTask(app: TestApp, processKey: string) {
  const tasks = await app.engine.searchUserTasks({ rootProcessInstanceKey: processKey });
  return tasks.find((t) => t.elementId === "escalation");
}

describe("agent-task SLA boundary — runtime escalation (#849)", () => {
  const savedEnv = new Map<string, string | undefined>();
  let restoreGithub: (() => void) | undefined;

  before(() => {
    for (const [k, v] of Object.entries(GITHUB_ENV_OVERRIDES)) {
      savedEnv.set(k, process.env[k]);
      process.env[k] = v;
    }
    restoreGithub = installAdmitGithub(admitGithubState("owner/repo", "main"));
  });

  after(() => {
    restoreGithub?.();
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function withApp(
    body: (ctx: { app: TestApp; processKey: string }) => Promise<void>,
    start: (app: TestApp) => Promise<string>,
  ): Promise<void> {
    const dbDir = mkdtempSync(join(tmpdir(), "nwf-849sla-"));
    const app = await bootTestApp(APP_ROOT, {
      env: { NANO_APP_DB_URL: `file:${join(dbDir, "app.db")}` },
    });
    try {
      const processKey = await start(app);
      await body({ app, processKey });
    } finally {
      await app.stop();
      rmSync(dbDir, { recursive: true, force: true });
    }
  }

  test("implement-cell (via a feature run): a hung agent hits its SLA boundary and escalates to a human", async () => {
    await withApp(
      async ({ app, processKey }) => {
        // Under the SLA the agent is still parked: no boundary flow, no escalation task yet.
        await advancePastTimer(app, UNDER_AGENT_SLA_MS);
        let flows = takenFlows(app);
        assert.ok(
          !flows.includes("be_implement_sla->record-escalation-sla"),
          "under the SLA the agent boundary has NOT fired",
        );
        assert.ok(
          !(await openEscalationTask(app, processKey)),
          "no human-escalation task before the SLA elapses",
        );

        // Past the SLA the interrupting boundary cancels the parked agent job and routes through the
        // SLA recorder to the shared human-escalation cell.
        await advancePastTimer(app, PAST_AGENT_SLA_MS);
        flows = takenFlows(app);
        assert.ok(
          flows.includes("be_implement_sla->record-escalation-sla"),
          `the agent SLA boundary fired into the SLA recorder (flows: ${flows.join(", ")})`,
        );
        assert.ok(
          flows.includes("record-escalation-sla->escalate"),
          "the SLA recorder handed off to the human-escalation cell",
        );
        const task = await openEscalationTask(app, processKey);
        assert.ok(task?.userTaskKey, "the human-escalation cell parked a completable escalation task");
      },
      async (app) => {
        parkAgent(app, "senior:feature");
        const featureKey = "owner/repo#7";
        const started = await app.api?.call("startFeature", { body: { issue: featureKey, baseBranch: "epic/e2e" } });
        assert.equal(started?.status, 202, "startFeature accepted the issue");
        await settleFully(app);
        const run = await app.db
          .table<{ feature_key: string; process_key: string | null }>("feature_runs", "feature_key")
          .findOne({ feature_key: featureKey });
        assert.ok(run?.process_key, "the feature_runs row carries the engine process-instance key");
        return run!.process_key!;
      },
    );
  });

  test("implement-cell (via a plan-fanout wave): the parent-mapped agentSlaTimeout arms the child boundary", async () => {
    await withApp(
      async ({ app, processKey }) => {
        await advancePastTimer(app, PAST_AGENT_SLA_MS);
        const flows = takenFlows(app);
        // The slice's implement-task is in the implement-cell child spawned by plan-fanout's MI body;
        // the boundary fires only because the parent now maps `agentSlaTimeout` into the call activity.
        assert.ok(
          flows.includes("be_implement_sla->record-escalation-sla"),
          `the wave slice's agent SLA boundary fired (flows: ${flows.join(", ")})`,
        );
        const task = await openEscalationTask(app, processKey);
        assert.ok(task?.userTaskKey, "the slice's human-escalation cell parked a completable escalation task");
      },
      async (app) => {
        // Plan + plan-review complete; the implement agent hangs.
        await app.engine.registerWorker("senior:plan", async () => ({ tasks: [{ id: "t1", title: "T1", prompt: "do t1" }] }));
        await app.engine.registerWorker("senior:plan-review", async () => ({ approved: true, findings: "" }));
        parkAgent(app, "senior:feature");
        const planKey = "owner/repo#1";
        const started = await app.api?.call("startPlanFanout", { body: { issue: planKey, baseBranch: "epic/e2e" } });
        assert.equal(started?.status, 202, "startPlanFanout accepted the issue");
        await settleFully(app);
        const plan = await app.db
          .table<{ plan_key: string; process_key: string | null }>("plans", "plan_key")
          .findOne({ plan_key: planKey });
        assert.ok(plan?.process_key, "the plan row carries the engine process-instance key");
        return plan!.process_key!;
      },
    );
  });
});
