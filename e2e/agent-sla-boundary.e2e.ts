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

// MUST be the FIRST import: pins `NANO_PR_AGENT_SLA_TIMEOUT` before `app/agentSla.ts` freezes its
// import-time `AGENT_SLA_TIMEOUT` const, so the suite is isolated from ambient config (see module).
import { PAST_AGENT_SLA_MS, UNDER_AGENT_SLA_MS } from "./support/pin-agent-sla.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";
import { AGENT_SLA_TIMEOUT } from "../app/agentSla.ts";
import { DEFAULT_ESCALATION_SLA_TIMEOUT } from "../app/escalationSla.ts";
import { admitGithubState, installAdmitGithub } from "./support/github-admit.ts";
import { advancePastTimer, settleFully } from "./support/time.ts";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const GITHUB_ENV_OVERRIDES: Record<string, string> = {
  NANO_PR_GITHUB_TRANSPORT: "token",
  GITHUB_TOKEN: "",
};

// The agent SLA is pinned to a fixed duration (PT2H) for this suite via ./support/pin-agent-sla.ts,
// so `AGENT_SLA_TIMEOUT` is deterministic regardless of the ambient `NANO_PR_AGENT_SLA_TIMEOUT`.
// `PAST_AGENT_SLA_MS` (1.5×) advances just past it so the AGENT boundary fires while the downstream
// human-escalation SLA (PT24H) stays dormant — isolating the agent-SLA arm; `UNDER_AGENT_SLA_MS`
// (0.25×) proves the boundary is genuinely armed on the seeded duration, not firing spuriously.
// Both thresholds derive from the SAME pinned duration, so they cannot drift from the seeded SLA.

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

/** Find an open user task by element id on a (possibly standalone-cell) instance. Used by the
 *  rerouted-arm scenarios below, whose human-decision tasks live directly on the cell's own
 *  instance (`trial-merge-decision`, `conformance-escalation`) rather than on a `human-escalation`
 *  grandchild. */
async function openTaskById(app: TestApp, processKey: string, elementId: string) {
  const tasks = await app.engine.searchUserTasks({ rootProcessInstanceKey: processKey });
  return tasks.find((t) => t.elementId === elementId);
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

// Runtime proof for the OTHER two rerouted agent-SLA arms landed this same round (#849 review r2).
// The implement-cell boundary above is driven through its real parents; merge-cell and retro are
// standalone cells (merge-cell is not yet composed by any callActivity, retro's trigger needs a
// whole epic's DB state), so we create each instance directly and seed exactly the process
// variables their real parents seed (`agentSlaTimeout`, and for merge-cell `escalationSlaTimeout`
// for the downstream human-decision boundary). Each test parks the agent at the bounded task,
// advances the engine clock past `agentSlaTimeout`, and asserts the token traversed the NEW
// recorder → escalation path — so a broken edge (wrong `targetRef`, or `agentSlaTimeout` missing
// from the recorder's scope) is caught by a red test, not at runtime. Mirrors the premise of the
// implement-cell suite above: a structural guard proves the boundary EXISTS; only this proves it
// ROUTES.
describe("agent-task SLA boundary — rerouted recorder→escalation arms (#849 review r2)", () => {
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

  async function bootApp(): Promise<{ app: TestApp; dbDir: string }> {
    const dbDir = mkdtempSync(join(tmpdir(), "nwf-849sla2-"));
    const app = await bootTestApp(APP_ROOT, {
      env: { NANO_APP_DB_URL: `file:${join(dbDir, "app.db")}` },
    });
    return { app, dbDir };
  }

  // The retro SLA recorders persist through `pr.conformance-record` → `recordConformance`, which
  // inserts into `plan_conformance` whose `plan_key` has a FOREIGN KEY to `plans` (052). Seed the
  // minimal parent row so the recorder's write doesn't violate the constraint — the real retro is
  // only ever started (app/retro.ts) for an already-recorded plan, so this mirrors production scope.
  async function seedPlan(app: TestApp, planKey: string): Promise<void> {
    const ts = new Date().toISOString();
    await app.db
      .table<Record<string, unknown>>("plans", "plan_key")
      .insert({
        plan_key: planKey,
        repo: "owner/repo",
        issue_number: 1,
        issue_url: "https://github.com/owner/repo/issues/1",
        status: "done",
        created_at: ts,
        updated_at: ts,
      });
  }

  test("merge-cell: a hung trial-merge agent hits be_trial_agent_sla and routes through record-trial-merge to the human decision", async () => {
    const { app, dbDir } = await bootApp();
    try {
      parkAgent(app, "senior:trial-merge");
      const { processInstanceKey } = await app.engine.createInstance({
        processDefinitionId: "merge-cell",
        variables: {
          planKey: "owner/repo#1",
          repo: "owner/repo",
          trialMergeWave: 1,
          agentSlaTimeout: AGENT_SLA_TIMEOUT,
          // Arms the downstream trial-merge-decision SLA boundary (`=escalationSlaTimeout`); a long
          // PT24H timer that must NOT fire in our 3h jump — without it the boundary's timer-creation
          // FEEL would resolve null and incident.
          escalationSlaTimeout: DEFAULT_ESCALATION_SLA_TIMEOUT,
        },
      });
      const processKey = String(processInstanceKey);

      // Under the SLA the agent is still parked: boundary not fired, no decision task yet.
      await advancePastTimer(app, UNDER_AGENT_SLA_MS);
      let flows = takenFlows(app);
      assert.ok(
        !flows.includes("be_trial_agent_sla->record-trial-merge-sla"),
        "under the SLA the trial-merge agent boundary has NOT fired",
      );
      assert.ok(
        !(await openTaskById(app, processKey, "trial-merge-decision")),
        "no trial-merge decision task before the SLA elapses",
      );

      // Past the SLA the interrupting boundary cancels the hung agent and routes through the
      // dedicated SLA recorder (record-trial-merge-sla) — NOT the shared normal-path recorder.
      await advancePastTimer(app, PAST_AGENT_SLA_MS);
      flows = takenFlows(app);
      assert.ok(
        flows.includes("be_trial_agent_sla->record-trial-merge-sla"),
        `the agent SLA boundary fired into the SLA recorder (flows: ${flows.join(", ")})`,
      );
      assert.ok(
        flows.includes("record-trial-merge-sla->gw-trial"),
        "the SLA recorder handed off to the trial-red gateway",
      );
      assert.ok(
        flows.includes("gw-trial->trial-merge-decision"),
        "a null/absent trial-merge result is treated as suite-failed and escalates to the human decision",
      );
      const task = await openTaskById(app, processKey, "trial-merge-decision");
      assert.ok(task?.userTaskKey, "the merge-cell parked a completable trial-merge decision task");
    } finally {
      await app.stop();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  // Regression for PR #864 review r3: on an SLA during a RERUN the recorder must not replay the
  // prior COMPLETED attempt's process-scope `result`/`summary`/`conflicts`/`failing`. The
  // `=null` ioMapping on `trial-merge` is task-local, so without a dedicated SLA recorder the
  // interrupted second attempt would inherit attempt one's stale verdict. Drive ONE instance: a
  // suite-failed first attempt escalates, the human answers "rebase" to rerun, the second agent
  // parks, the SLA fires — then assert on the durable audit (`plan_trial_merges`): the SLA row must
  // carry the TIMEOUT verdict (and cleared conflicts/failing), while the first attempt's row keeps
  // the agent's real output (the normal path is not clobbered by the SLA literals).
  test("merge-cell: an SLA on a rerun does NOT replay the prior attempt's stale result/summary", async () => {
    const { app, dbDir } = await bootApp();
    try {
      // First dispatch completes SUITE-FAILED with a distinctive stale summary (seeding process
      // scope); the rerun's dispatch parks (the `firstDone` flag flips the mock to no-match → the
      // job stays locked → the SLA boundary fires).
      let firstDone = false;
      app.engine
        .mockWorker("senior:trial-merge")
        .when(() => !firstDone)
        .completeWith({
          result: "suite-failed",
          summary: "stale prior-attempt summary",
          conflicts: ["stale-conflict"],
          failing: ["stale-spec"],
        });

      const { processInstanceKey } = await app.engine.createInstance({
        processDefinitionId: "merge-cell",
        variables: {
          planKey: "owner/repo#1",
          repo: "owner/repo",
          trialMergeWave: 1,
          agentSlaTimeout: AGENT_SLA_TIMEOUT,
          escalationSlaTimeout: DEFAULT_ESCALATION_SLA_TIMEOUT,
        },
      });
      const processKey = String(processInstanceKey);
      await settleFully(app);

      // Attempt 1 escalates to the human decision; its audit row keeps the AGENT's real output
      // (proving the dedicated SLA recorder's literals do NOT clobber the normal path).
      let flows = takenFlows(app);
      assert.ok(
        flows.includes("trial-merge->record-trial-merge") && flows.includes("gw-trial->trial-merge-decision"),
        `a suite-failed first attempt records normally and escalates (flows: ${flows.join(", ")})`,
      );
      const auditsAfterFirst = await app.db
        .table<{ id: number; plan_key: string; summary: string | null }>("plan_trial_merges", "id")
        .find({ plan_key: "owner/repo#1" });
      assert.equal(auditsAfterFirst.length, 1, "one audit row after the first attempt");
      assert.equal(
        auditsAfterFirst[0].summary,
        "stale prior-attempt summary",
        "the normal path records the agent's real summary (not the SLA literal)",
      );
      const first = await openTaskById(app, processKey, "trial-merge-decision");
      assert.ok(first?.userTaskKey, "the first attempt parked a trial-merge decision task");

      // The human answers "rebase" → the cell reruns trial-merge. Park the second agent.
      firstDone = true;
      await app.engine.completeUserTask(first!.userTaskKey, { action: "rebase" });
      await settleFully(app);
      flows = takenFlows(app);
      assert.ok(
        flows.includes("gw-trial-answer->trial-merge"),
        `the rebase answer reran the trial-merge agent (flows: ${flows.join(", ")})`,
      );

      // The second agent hangs; the SLA fires. The DEDICATED SLA recorder must pin the TIMEOUT verdict.
      await advancePastTimer(app, PAST_AGENT_SLA_MS);
      flows = takenFlows(app);
      assert.ok(
        flows.includes("be_trial_agent_sla->record-trial-merge-sla"),
        `the rerun's agent SLA boundary fired into the dedicated SLA recorder (flows: ${flows.join(", ")})`,
      );
      assert.ok(
        flows.includes("record-trial-merge-sla->gw-trial") && flows.includes("gw-trial->trial-merge-decision"),
        "the SLA timeout verdict (suite-failed) routes through the gateway to the human decision again",
      );

      // The decisive assertion: the SLA audit row carries the TIMEOUT summary with CLEARED
      // conflicts/failing — NOT the stale first-attempt values a shared recorder would have replayed.
      const audits = await app.db
        .table<{ id: number; plan_key: string; result: string; summary: string | null; conflicts: string | null; failing: string | null }>(
          "plan_trial_merges",
          "id",
        )
        .find({ plan_key: "owner/repo#1" });
      const slaRow = audits.sort((a, b) => b.id - a.id)[0];
      assert.equal(slaRow.result, "suite-failed", "the SLA row records the timeout verdict");
      assert.equal(
        slaRow.summary,
        `The trial-merge agent exceeded its time budget (SLA ${AGENT_SLA_TIMEOUT}) without returning a machine-readable result — it is hung or looping. Acknowledge to record the timeout and decide whether to rerun the trial merge.`,
        "the SLA row pins the timeout summary, not the stale prior-attempt summary",
      );
      assert.equal(slaRow.conflicts, null, "the SLA row clears the stale prior-attempt conflicts");
      assert.equal(slaRow.failing, null, "the SLA row clears the stale prior-attempt failing list");
    } finally {
      await app.stop();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  test("retro: a hung conformance agent hits be_conformance_sla and routes through record-conformance-sla to the human review", async () => {
    const { app, dbDir } = await bootApp();
    try {
      await seedPlan(app, "owner/repo#1");
      parkAgent(app, "senior:conformance");
      const { processInstanceKey } = await app.engine.createInstance({
        processDefinitionId: "retro",
        variables: {
          planKey: "owner/repo#1",
          repo: "owner/repo",
          issueUrl: "https://github.com/owner/repo/issues/1",
          agentSlaTimeout: AGENT_SLA_TIMEOUT,
        },
      });
      const processKey = String(processInstanceKey);
      // Let `gather` (pr.retro-gather) complete and the conformance agent park before arming the clock.
      await settleFully(app);

      await advancePastTimer(app, UNDER_AGENT_SLA_MS);
      let flows = takenFlows(app);
      assert.ok(
        !flows.includes("be_conformance_sla->record-conformance-sla"),
        "under the SLA the conformance agent boundary has NOT fired",
      );
      assert.ok(
        !(await openTaskById(app, processKey, "conformance-escalation")),
        "no conformance-escalation task before the SLA elapses",
      );

      await advancePastTimer(app, PAST_AGENT_SLA_MS);
      flows = takenFlows(app);
      assert.ok(
        flows.includes("be_conformance_sla->record-conformance-sla"),
        `the conformance agent SLA boundary fired into its recorder (flows: ${flows.join(", ")})`,
      );
      assert.ok(
        flows.includes("record-conformance-sla->conformance-escalation"),
        "the SLA recorder handed off to the human conformance review",
      );
      const task = await openTaskById(app, processKey, "conformance-escalation");
      assert.ok(task?.userTaskKey, "the retro parked a completable conformance-escalation task");
    } finally {
      await app.stop();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  test("retro: a hung synthesize agent hits be_synthesize_sla and routes through record-synthesize-sla to the human review", async () => {
    const { app, dbDir } = await bootApp();
    try {
      // Conformance completes cleanly (no deviations) so the token reaches `synthesize`; that agent hangs.
      await app.engine.registerWorker("senior:conformance", async () => ({ status: "skipped" }));
      parkAgent(app, "senior:retro");
      await seedPlan(app, "owner/repo#1");
      const { processInstanceKey } = await app.engine.createInstance({
        processDefinitionId: "retro",
        variables: {
          planKey: "owner/repo#1",
          repo: "owner/repo",
          issueUrl: "https://github.com/owner/repo/issues/1",
          agentSlaTimeout: AGENT_SLA_TIMEOUT,
        },
      });
      const processKey = String(processInstanceKey);
      // Let gather + conformance + record-conformance run and the synthesize agent park before arming.
      await settleFully(app);

      await advancePastTimer(app, UNDER_AGENT_SLA_MS);
      let flows = takenFlows(app);
      assert.ok(
        flows.includes("gw-deviations->synthesize"),
        `a clean conformance run reaches synthesize (flows: ${flows.join(", ")})`,
      );
      assert.ok(
        !flows.includes("be_synthesize_sla->record-synthesize-sla"),
        "under the SLA the synthesize agent boundary has NOT fired",
      );

      await advancePastTimer(app, PAST_AGENT_SLA_MS);
      flows = takenFlows(app);
      assert.ok(
        flows.includes("be_synthesize_sla->record-synthesize-sla"),
        `the synthesize agent SLA boundary fired into its recorder (flows: ${flows.join(", ")})`,
      );
      assert.ok(
        flows.includes("record-synthesize-sla->conformance-escalation"),
        "the synthesize SLA recorder handed off to the human conformance review",
      );
      const task = await openTaskById(app, processKey, "conformance-escalation");
      assert.ok(task?.userTaskKey, "the retro parked a completable conformance-escalation task on the synthesize-SLA arm");
    } finally {
      await app.stop();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  test("retro: a synthesize SLA does NOT overwrite the conformance verdict filed earlier in the same run", async () => {
    const { app, dbDir } = await bootApp();
    try {
      // Conformance FILES a real verdict (with a report comment + per-item counts) and NO deviations,
      // so the token routes on to `synthesize`; that agent then hangs and its SLA fires. The preserve
      // path must leave the filed verdict intact.
      await app.engine.registerWorker("senior:conformance", async () => ({
        status: "filed",
        commentUrl: "https://github.com/owner/repo/issues/1#issuecomment-9",
        slicesMet: 3,
        slicesReduced: 0,
        slicesNotVerified: 0,
        deviationsRaised: 0,
        deviationsUnraised: 0,
        hasDeviations: false,
        summary: "3 items, 3 met",
      }));
      parkAgent(app, "senior:retro");
      await seedPlan(app, "owner/repo#1");
      const { processInstanceKey } = await app.engine.createInstance({
        processDefinitionId: "retro",
        variables: {
          planKey: "owner/repo#1",
          repo: "owner/repo",
          issueUrl: "https://github.com/owner/repo/issues/1",
          agentSlaTimeout: AGENT_SLA_TIMEOUT,
        },
      });
      const processKey = String(processInstanceKey);
      await settleFully(app);

      // The filed conformance verdict is recorded before synthesize parks.
      const filed = await app.db
        .table<{ status: string; summary: string | null; slices_met: number; report: string | null }>(
          "plan_conformance",
          "plan_key",
        )
        .get("owner/repo#1");
      assert.equal(filed?.status, "filed", "the conformance verdict was filed before synthesize");
      assert.equal(filed?.slices_met, 3);

      // Fire the synthesize SLA.
      await advancePastTimer(app, PAST_AGENT_SLA_MS);
      const flows = takenFlows(app);
      assert.ok(
        flows.includes("be_synthesize_sla->record-synthesize-sla"),
        `the synthesize SLA boundary fired (flows: ${flows.join(", ")})`,
      );
      const task = await openTaskById(app, processKey, "conformance-escalation");
      assert.ok(task?.userTaskKey, "the synthesize-SLA arm parked the conformance-escalation task");

      // The decisive assertion: the filed conformance verdict SURVIVES the synthesize-SLA timeout —
      // status/counts/report unchanged, review_status flipped to reviewing, and the synthesis-timeout
      // reason APPENDED to (not replacing) the audit summary.
      const row = await app.db
        .table<{
          status: string;
          comment_url: string | null;
          slices_met: number;
          slices_reduced: number;
          has_deviations: number;
          summary: string | null;
          report: string | null;
          review_status: string;
        }>("plan_conformance", "plan_key")
        .get("owner/repo#1");
      assert.equal(row?.status, "filed", "the filed verdict status is preserved, not reset to skipped");
      assert.equal(row?.comment_url, "https://github.com/owner/repo/issues/1#issuecomment-9");
      assert.equal(row?.slices_met, 3, "the verdict counts are preserved");
      assert.equal(row?.slices_reduced, 0);
      assert.equal(row?.review_status, "reviewing", "the escalation is tracked for the ack task");
      assert.ok(
        (row?.summary ?? "").startsWith("3 items, 3 met"),
        `the audit summary is preserved and the SLA reason appended (got: ${row?.summary})`,
      );
      assert.ok(
        (row?.summary ?? "").includes("retrospective-synthesis agent exceeded its time budget"),
        "the synthesis-timeout context is appended to the summary",
      );
    } finally {
      await app.stop();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
