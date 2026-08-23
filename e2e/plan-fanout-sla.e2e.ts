// End-to-end proof for the escalation-of-the-escalation SLA timer boundaries and operator
// assignment on the plan-fanout escalation user tasks (epic #156, slice U5). Boots the whole app
// against the WASM engine + virtual clock and drives the REAL plan-fanout.bpmn to each of its three
// human-decision user tasks — the implementation-phase task escalation, the plan-review cap
// escalation, and the trial-merge escalation — then, WITHOUT answering, advances the virtual clock
// past the seeded `escalationSlaTimeout` so each task's interrupting timer boundary fires. It
// asserts the token took the boundary's safe-default auto-proceed arm (never the human-answer arm),
// and that each escalation task is discoverable by its `operators` candidate group (and not by a
// bogus group) — i.e. the inbox is assignment-filterable.
//
// The boundary path is the falsifiable core (mirroring U0/U2): the WASM engine folds a completed
// instance's variables away, so we assert on the cumulative taken sequence flows. An unanswered task
// with no SLA boundary would simply hang — never taking a boundary flow — so a green here proves the
// durable in-process liveness the slice lands. Each scenario boots its own app so `takenSequenceFlows`
// (engine-global, cumulative) reflects exactly one instance's routing.
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
import { admitGithubState, installAdmitGithub } from "./support/github-admit.ts";
import { advancePastTimer } from "./support/time.ts";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const GITHUB_ENV_OVERRIDES: Record<string, string> = {
  NANO_PR_GITHUB_TRANSPORT: "token",
  GITHUB_TOKEN: "",
};

// Advance well past the default escalation SLA (PT24H) so every armed boundary timer is due.
const PAST_SLA_MS = 25 * 60 * 60 * 1000;

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

type Stub = (job: EngineJob) => Record<string, unknown> | void;

describe("plan-fanout escalation SLA + assignment (U5)", () => {
  const savedEnv = new Map<string, string | undefined>();
  let restoreGithub: (() => void) | undefined;

  before(() => {
    for (const [k, v] of Object.entries(GITHUB_ENV_OVERRIDES)) {
      savedEnv.set(k, process.env[k]);
      process.env[k] = v;
    }
    // ADR 0003: `startPlanFanout` + the `pr.ensure-base-branch` head task now pass through base
    // admission, which reads/creates the base ref. Pin the hermetic `token` transport + fetch stub.
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
    stubs: Record<string, Stub>,
    body: (ctx: { app: TestApp; planKey: string; processKey: string }) => Promise<void>,
  ): Promise<void> {
    const dbDir = mkdtempSync(join(tmpdir(), "nwf-u5-"));
    const app = await bootTestApp(APP_ROOT, {
      env: { NANO_APP_DB_URL: `file:${join(dbDir, "app.db")}` },
    });
    try {
      for (const [jobType, stub] of Object.entries(stubs)) {
        await app.engine.registerWorker(jobType, async (job) => stub(job) ?? undefined);
      }
      const planKey = "owner/repo#1";
      const started = await app.api?.call("startPlanFanout", { body: { issue: planKey, baseBranch: "epic/e2e" } });
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

  /** Assert the escalation task is discoverable by the `operators` candidate group (the inbox
   *  filter) and NOT by a bogus group — proving `zeebe:assignmentDefinition candidateGroups` took. */
  async function assertAssignmentFilterable(app: TestApp, processKey: string, elementId: string) {
    const byOperators = await app.engine.searchUserTasks({
      processInstanceKey: processKey,
      candidateGroup: "operators",
    });
    assert.ok(
      byOperators.some((t) => t.elementId === elementId),
      `${elementId} is filterable by the operators candidate group`,
    );
    const byBogus = await app.engine.searchUserTasks({
      processInstanceKey: processKey,
      candidateGroup: "nobody-here",
    });
    assert.ok(
      !byBogus.some((t) => t.elementId === elementId),
      `${elementId} is NOT surfaced under a group it does not belong to`,
    );
  }

  const singleTaskPlan: Stub = () => ({ tasks: [{ id: "t1", title: "T1", prompt: "do t1" }] });
  const approveReview: Stub = () => ({ approved: true, findings: "" });

  test("task escalation: an unanswered task hits its SLA boundary and auto-abandons the slice", async () => {
    await withApp(
      {
        "senior:plan": singleTaskPlan,
        "senior:plan-review": approveReview,
        "senior:feature": () => ({
          status: "escalated",
          question: "Which API should I use?",
          summary: "parked for a human",
        }),
      },
      async ({ app, processKey }) => {
        await openTask(app, processKey, "feature-escalation");
        await assertAssignmentFilterable(app, processKey, "feature-escalation");

        // Never answer — let the SLA elapse. The interrupting boundary cancels the parked task and
        // routes to the task-done end (the safe auto-abandon default).
        await advancePastTimer(app, PAST_SLA_MS);

        const flows = takenFlows(app);
        assert.ok(
          flows.includes("be_feature_sla->w_end"),
          `the SLA boundary auto-abandoned to the task-done end (flows: ${flows.join(", ")})`,
        );
        assert.ok(
          !flows.includes("w_gw_answer->implement-task"),
          "the human answer loop was NOT taken",
        );
      },
    );
  });

  test("plan-review escalation: an unanswered task hits its SLA boundary and auto-revises", async () => {
    await withApp(
      {
        "senior:plan": singleTaskPlan,
        "senior:plan-review": () => ({ approved: false, findings: "not good enough" }),
        "senior:feature": () => ({ status: "blocked", summary: "n/a" }),
      },
      async ({ app, processKey }) => {
        await openTask(app, processKey, "plan-review-decision");
        await assertAssignmentFilterable(app, processKey, "plan-review-decision");

        await advancePastTimer(app, PAST_SLA_MS);

        const flows = takenFlows(app);
        assert.ok(
          flows.includes("be_plan_sla->plan"),
          `the SLA boundary auto-revised back to plan (flows: ${flows.join(", ")})`,
        );
        assert.ok(
          !flows.includes("gw-plan-answer->select-wave"),
          "the human proceed-override arm was NOT taken",
        );
      },
    );
  });

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

  test("trial-merge escalation: an unanswered task hits its SLA boundary and auto-reruns", async () => {
    await withApp(
      {
        "senior:plan": twoTaskPlan,
        "senior:plan-review": approveReview,
        "senior:feature": openBothPrs,
        "senior:trial-merge": trialSuiteFailed,
      },
      async ({ app, processKey }) => {
        await openTask(app, processKey, "trial-merge-decision");
        await assertAssignmentFilterable(app, processKey, "trial-merge-decision");

        await advancePastTimer(app, PAST_SLA_MS);

        const flows = takenFlows(app);
        assert.ok(
          flows.includes("be_trial_sla->trial-merge"),
          `the SLA boundary auto-reran the trial merge (flows: ${flows.join(", ")})`,
        );
        assert.ok(
          !flows.includes("gw-trial-answer->gw-more"),
          "the human proceed arm was NOT taken",
        );
      },
    );
  });
});
