// End-to-end proof for the plan-fanout escalations migrated to native user tasks + forms
// (epic #156, slice U2). Boots the whole app against the WASM engine and drives the REAL
// plan-fanout.bpmn to each of its three human-decision points — the implementation-phase task
// escalation, the plan-review cap escalation, and the trial-merge escalation — by registering stub
// `senior:*` agent workers that steer the process. At each park it asserts the escalation is a
// native `userTask`, then completes it via the engine's user-task API and asserts the TYPED
// completion variables routed the downstream decision gateway.
//
// The gateway assertions are the falsifiable core (mirroring the U0 spine): the WASM engine folds a
// completed instance's variables away, so we assert on the cumulative taken sequence flows instead
// — an empty/wrong completion would take a different (default) branch. Each scenario boots its own
// app so `takenSequenceFlows` (engine-global, cumulative) reflects exactly one instance's routing.
//
// Run with `npm run e2e`.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EngineJob } from "@nanobpm/urban/runtime";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const GITHUB_ENV_OVERRIDES: Record<string, string> = {
  NANO_PR_GITHUB_TRANSPORT: "token",
  GITHUB_TOKEN: "",
};

interface InboxTask {
  userTaskKey: string;
  elementId?: string;
  variables?: Record<string, unknown>;
}

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

/** A stub `senior:*` agent worker. Handlers are keyed by job type; each returns the process
 *  variables the real agent would emit. */
type Stub = (job: EngineJob) => Record<string, unknown> | void;

describe("plan-fanout escalations (U2 — task + plan-review + trial-merge → userTask + form)", () => {
  const savedEnv = new Map<string, string | undefined>();

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

  /** Boot a fresh app (isolated engine + DB), register the given `senior:*` stubs, run `body`, and
   *  tear down. Each scenario gets its own engine so `takenSequenceFlows` is that run's alone. */
  async function withApp(
    stubs: Record<string, Stub>,
    body: (ctx: { app: TestApp; planKey: string; processKey: string }) => Promise<void>,
  ): Promise<void> {
    const dbDir = mkdtempSync(join(tmpdir(), "nwf-u2-"));
    const app = await bootTestApp(APP_ROOT, {
      env: { NANO_APP_DB_URL: `file:${join(dbDir, "app.db")}` },
    });
    try {
      for (const [jobType, stub] of Object.entries(stubs)) {
        await app.engine.registerWorker(jobType, async (job) => stub(job) ?? undefined);
      }
      const planKey = "owner/repo#1";
      const started = await app.api?.call("startPlanFanout", { body: { issue: planKey } });
      assert.equal(started?.status, 202, "startPlanFanout accepted the issue");
      await app.settle();
      const plan = await app.db
        .table<{ plan_key: string; process_key: string | null }>("plans", "plan_key")
        .findOne({ plan_key: planKey });
      assert.ok(plan?.process_key, "the plan row carries the engine process-instance key");
      await body({ app, planKey, processKey: plan!.process_key! });
    } finally {
      await app.stop();
      rmSync(dbDir, { recursive: true, force: true });
    }
  }

  async function openTask(app: TestApp, processKey: string, elementId: string): Promise<InboxTask> {
    const tasks = await app.engine.searchUserTasks({ processInstanceKey: processKey });
    const match = tasks.find((t) => t.elementId === elementId);
    assert.ok(match, `expected an open ${elementId} user task (open: ${tasks.map((t) => t.elementId).join(", ")})`);
    return match!;
  }

  // A planner that emits a single independent task, and a reviewer that approves — the shortest
  // path to the implementation phase where the task escalation lives.
  const singleTaskPlan: Stub = () => ({ tasks: [{ id: "t1", title: "T1", prompt: "do t1" }] });
  const approveReview: Stub = () => ({ approved: true, findings: "" });

  test("task escalation: a native userTask parks the child; answering routes back to implement-task", async () => {
    let featureCalls = 0;
    await withApp(
      {
        "senior:plan": singleTaskPlan,
        "senior:plan-review": approveReview,
        "senior:feature": () => {
          featureCalls += 1;
          return featureCalls === 1
            ? { status: "escalated", question: "Which API should I use?", summary: "parked for a human" }
            : { status: "blocked", summary: "resumed after answer" };
        },
      },
      async ({ app, processKey }) => {
        const task = await openTask(app, processKey, "feature-escalation");
        assert.ok(task.userTaskKey, "the feature escalation carries a completable userTaskKey");

        // Answer it: the typed resolution loops the child back to re-dispatch the SAME task.
        await app.engine.completeUserTask(task.userTaskKey, { resolution: "answer", answer: "use v2" });
        await app.settle();

        const flows = takenFlows(app);
        assert.ok(
          flows.includes("w_gw_answer->implement-task"),
          `answer routed back to implement-task (flows: ${flows.join(", ")})`,
        );
        assert.ok(
          !flows.includes("w_gw_answer->w_end"),
          "the abandon (default) flow was NOT taken",
        );
      },
    );
  });

  test("task escalation: abandoning routes to the task-done end (default flow)", async () => {
    await withApp(
      {
        "senior:plan": singleTaskPlan,
        "senior:plan-review": approveReview,
        "senior:feature": () => ({
          status: "escalated",
          question: "Blocked — abandon?",
          summary: "parked",
        }),
      },
      async ({ app, processKey }) => {
        const task = await openTask(app, processKey, "feature-escalation");
        await app.engine.completeUserTask(task.userTaskKey, { resolution: "abandon" });
        await app.settle();

        const flows = takenFlows(app);
        assert.ok(
          flows.includes("w_gw_answer->w_end"),
          `abandon routed to the task-done end (flows: ${flows.join(", ")})`,
        );
        assert.ok(
          !flows.includes("w_gw_answer->implement-task"),
          "the answer loop was NOT taken",
        );
      },
    );
  });

  test("plan-review escalation: proceed overrides the gate and routes to select-wave", async () => {
    await withApp(
      {
        "senior:plan": singleTaskPlan,
        "senior:plan-review": () => ({ approved: false, findings: "not good enough" }),
        "senior:feature": () => ({ status: "blocked", summary: "n/a" }),
      },
      async ({ app, processKey }) => {
        const task = await openTask(app, processKey, "plan-review-decision");
        await app.engine.completeUserTask(task.userTaskKey, { directive: "proceed", notes: "ship it" });
        await app.settle();

        const flows = takenFlows(app);
        assert.ok(
          flows.includes("gw-plan-answer->select-wave"),
          `proceed routed to select-wave (flows: ${flows.join(", ")})`,
        );
        assert.ok(
          !flows.includes("gw-plan-answer->plan"),
          "the revise (default) flow was NOT taken",
        );
      },
    );
  });

  test("plan-review escalation: revise loops back to plan and resets the review epoch", async () => {
    await withApp(
      {
        "senior:plan": singleTaskPlan,
        "senior:plan-review": () => ({ approved: false, findings: "still not good" }),
        "senior:feature": () => ({ status: "blocked", summary: "n/a" }),
      },
      async ({ app, planKey, processKey }) => {
        const task = await openTask(app, processKey, "plan-review-decision");
        await app.engine.completeUserTask(task.userTaskKey, { directive: "revise", notes: "narrow scope" });
        await app.settle();

        const flows = takenFlows(app);
        assert.ok(
          flows.includes("gw-plan-answer->plan"),
          `revise routed back to plan (flows: ${flows.join(", ")})`,
        );

        // The user task bumped `planReviewEpoch`; record-plan-review derived the fresh epoch and
        // reset the round budget — proving the epoch is computed from completed plan-review tasks
        // across rounds (epoch 0's rounds, then a fresh epoch 1 round 0 after the human revise).
        const reviews = await app.db
          .table<{ plan_key: string; epoch: number; round: number }>("plan_reviews", "plan_key")
          .find({ plan_key: planKey });
        assert.ok(
          reviews.some((r) => r.epoch === 0),
          "the first review epoch (0) was recorded",
        );
        assert.ok(
          reviews.some((r) => r.epoch === 1 && r.round === 0),
          `a fresh epoch 1 round 0 was recorded after revise (epochs: ${reviews.map((r) => `${r.epoch}.${r.round}`).join(", ")})`,
        );
      },
    );
  });

  // A two-task wave whose PRs both open triggers the D3 trial-merge gate; a suite-failed trial
  // parks on the trial-merge decision user task.
  const twoTaskPlan: Stub = () => ({
    tasks: [
      { id: "t1", title: "T1", prompt: "do t1" },
      { id: "t2", title: "T2", prompt: "do t2" },
    ],
  });
  const openBothPrs: Stub = (job) => {
    const taskId = (job.variables as { task?: { id?: string } }).task?.id;
    return taskId === "t2"
      ? { status: "opened", pr: "owner/repo#102", summary: "opened t2" }
      : { status: "opened", pr: "owner/repo#101", summary: "opened t1" };
  };
  const trialSuiteFailed: Stub = () => ({ result: "suite-failed", failing: "combined suite red" });

  async function driveToTrialDecision(
    action: string,
  ): Promise<string[]> {
    let flows: string[] = [];
    await withApp(
      {
        "senior:plan": twoTaskPlan,
        "senior:plan-review": approveReview,
        "senior:feature": openBothPrs,
        "senior:trial-merge": trialSuiteFailed,
      },
      async ({ app, processKey }) => {
        const task = await openTask(app, processKey, "trial-merge-decision");
        await app.engine.completeUserTask(task.userTaskKey, { action, notes: `chose ${action}` });
        await app.settle();
        flows = takenFlows(app);
      },
    );
    return flows;
  }

  test("trial-merge escalation: proceed routes to the more-waves gate", async () => {
    const flows = await driveToTrialDecision("proceed");
    assert.ok(
      flows.includes("gw-trial-answer->gw-more"),
      `proceed routed to gw-more (flows: ${flows.join(", ")})`,
    );
  });

  test("trial-merge escalation: rebase re-runs the trial merge (default flow)", async () => {
    const flows = await driveToTrialDecision("rebase");
    assert.ok(
      flows.includes("gw-trial-answer->trial-merge"),
      `rebase routed back to trial-merge (flows: ${flows.join(", ")})`,
    );
  });

  test("trial-merge escalation: abandon finalizes the plan", async () => {
    const flows = await driveToTrialDecision("abandon");
    assert.ok(
      flows.includes("gw-trial-answer->record-results"),
      `abandon routed to record-results (flows: ${flows.join(", ")})`,
    );
  });
});
