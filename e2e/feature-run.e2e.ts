// End-to-end proof for the single-issue feature run (issue #172). Boots the whole app against the
// WASM engine and drives the REAL feature.bpmn through its three outcomes:
//   • raise-only — the agent opens a PR, `converge` is off → the run ends at `opened`, no hand-off;
//   • raise + converge — with `converge` on, the opened PR is enrolled into the convergence loop
//     (a `pull_requests` row appears) and the feature_run lands `converging`;
//   • escalate + resume — the agent escalates, a native `feature-escalation` user task parks the
//     run, and answering re-dispatches the SAME implement task (mirrors the epic slice).
//
// The gateway assertions are the falsifiable core: the WASM engine folds a completed instance's
// variables away, so we assert on the cumulative taken sequence flows (an empty/wrong result takes a
// different, default branch). Each scenario boots its own app so `takenSequenceFlows`
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

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const GITHUB_ENV_OVERRIDES: Record<string, string> = {
  NANO_PR_GITHUB_TRANSPORT: "token",
  GITHUB_TOKEN: "",
};

interface InboxTask {
  userTaskKey: string;
  elementId?: string;
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

interface FeatureRow {
  feature_key: string;
  process_key: string | null;
  status: string;
  pr_key: string | null;
  delivery_label: string | null;
}
interface PrRow {
  pr_key: string;
}

describe("single-issue feature run (#172 — feature.bpmn)", () => {
  const savedEnv = new Map<string, string | undefined>();
  let restoreGithub: (() => void) | undefined;

  before(() => {
    for (const [k, v] of Object.entries(GITHUB_ENV_OVERRIDES)) {
      savedEnv.set(k, process.env[k]);
      process.env[k] = v;
    }
    // ADR 0003: `startFeature` + the `pr.ensure-base-branch` head task pass through base admission,
    // which reads/creates the base ref. Pin the hermetic `token` transport + fetch stub.
    restoreGithub = installAdmitGithub(admitGithubState("owner/repo", "main"));
  });

  after(() => {
    restoreGithub?.();
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** Boot a fresh app (isolated engine + DB), register the given `senior:*` stubs, run `body`, and
   *  tear down. Each scenario gets its own engine so `takenSequenceFlows` is that run's alone. */
  async function withApp(
    stubs: Record<string, Stub>,
    startBody: Record<string, unknown>,
    body: (ctx: { app: TestApp; featureKey: string; processKey: string }) => Promise<void>,
  ): Promise<void> {
    const dbDir = mkdtempSync(join(tmpdir(), "nwf-f172-"));
    const app = await bootTestApp(APP_ROOT, {
      env: { NANO_APP_DB_URL: `file:${join(dbDir, "app.db")}` },
    });
    try {
      for (const [jobType, stub] of Object.entries(stubs)) {
        await app.engine.registerWorker(jobType, async (job) => stub(job) ?? undefined);
      }
      const featureKey = "owner/repo#7";
      const started = await app.api?.call("startFeature", { body: { issue: featureKey, ...startBody } });
      assert.equal(started?.status, 202, "startFeature accepted the issue");
      await app.settle();
      const run = await app.db
        .table<FeatureRow>("feature_runs", "feature_key")
        .findOne({ feature_key: featureKey });
      assert.ok(run?.process_key, "the feature_runs row carries the engine process-instance key");
      await body({ app, featureKey, processKey: run!.process_key! });
    } finally {
      await app.stop();
      rmSync(dbDir, { recursive: true, force: true });
    }
  }

  async function featureRow(app: TestApp, featureKey: string): Promise<FeatureRow> {
    const run = await app.db.table<FeatureRow>("feature_runs", "feature_key").findOne({ feature_key: featureKey });
    assert.ok(run, `feature_runs row for ${featureKey} exists`);
    return run!;
  }

  test("raise-only: an opened PR ends the run at `opened`, taking the raise-only branch", async () => {
    await withApp(
      { "senior:feature": () => ({ status: "opened", pr: "owner/repo#101", summary: "built it" }) },
      { baseBranch: "epic/e2e" },
      async ({ app, featureKey }) => {
        const flows = takenFlows(app);
        assert.ok(
          flows.includes("gw-converge->End"),
          `converge=false took the raise-only branch (flows: ${flows.join(", ")})`,
        );
        assert.ok(!flows.includes("gw-converge->converge"), "the converge hand-off branch was NOT taken");

        const run = await featureRow(app, featureKey);
        assert.equal(run.status, "opened", "the run settled at opened");
        assert.equal(run.pr_key, "owner/repo#101", "the raised PR key was recorded");

        const prs = await app.db.table<PrRow>("pull_requests", "pr_key").find({});
        assert.equal(prs.length, 0, "raise-only did NOT enroll the PR into the convergence loop");
      },
    );
  });

  test("raise + converge: the opened PR is enrolled into the convergence loop", async () => {
    await withApp(
      { "senior:feature": () => ({ status: "opened", pr: "owner/repo#102", summary: "built it" }) },
      { baseBranch: "epic/e2e", converge: true },
      async ({ app, featureKey }) => {
        const flows = takenFlows(app);
        assert.ok(
          flows.includes("gw-converge->converge"),
          `converge=true took the hand-off branch (flows: ${flows.join(", ")})`,
        );

        const run = await featureRow(app, featureKey);
        assert.equal(run.status, "converging", "the run settled at converging");

        const pr = await app.db.table<PrRow>("pull_requests", "pr_key").findOne({ pr_key: "owner/repo#102" });
        assert.ok(pr, "converge enrolled the raised PR into pull_requests (submitPr hand-off)");
      },
    );
  });

  test("blocked: parks at the operators' user task (non-terminal), never enrolls a PR, settles on ack", async () => {
    await withApp(
      { "senior:feature": () => ({ status: "blocked", summary: "could not proceed" }) },
      { baseBranch: "epic/e2e", converge: true },
      async ({ app, featureKey, processKey }) => {
        const flows = takenFlows(app);
        assert.ok(
          flows.includes("gw-blocked->feature-blocked"),
          `a blocked run routes to the operators' user task, not the converge gateway (flows: ${flows.join(", ")})`,
        );
        assert.ok(!flows.includes("gw-blocked->gw-converge"), "a blocked run never reaches the converge gateway");

        // The instance stays alive parked at a completable native user task (operators inbox) — a
        // blocked run is never a silent dead-end — and the row is NON-terminal `awaiting_operator`
        // so a re-dispatch of the same issue short-circuits (no orphaned parallel run).
        const tasks = await app.engine.searchUserTasks({ processInstanceKey: processKey });
        const task = tasks.find((t) => t.elementId === "feature-blocked") as InboxTask | undefined;
        assert.ok(task?.userTaskKey, "the blocked outcome parked a completable native user task");

        const parked = await featureRow(app, featureKey);
        assert.equal(parked.status, "awaiting_operator", "while parked the run is non-terminal awaiting_operator");
        assert.equal(parked.pr_key, null);
        const prs = await app.db.table<PrRow>("pull_requests", "pr_key").find({});
        assert.equal(prs.length, 0, "a blocked run never enrolled a PR into the convergence loop");

        // Acknowledging the blocked run records the note, settles it terminal `blocked`, and ends.
        await app.engine.completeUserTask(task!.userTaskKey, { note: "reassigned to a human" });
        await app.settle();
        const flows2 = takenFlows(app);
        assert.ok(flows2.includes("feature-blocked->record-blocked-ack"), "ack routes through record-blocked-ack");
        assert.ok(flows2.includes("record-blocked-ack->End"), "the acknowledged run ends");
        const settled = await featureRow(app, featureKey);
        assert.equal(settled.status, "blocked", "the acknowledged run settles at terminal blocked");
        assert.equal(settled.delivery_label, "operator: reassigned to a human", "the operator note is recorded");
      },
    );
  });

  test("escalate + resume: a native userTask parks the run; answering re-dispatches implement-task", async () => {
    let calls = 0;
    await withApp(
      {
        "senior:feature": () => {
          calls += 1;
          return calls === 1
            ? { status: "escalated", question: "Which API should I use?", summary: "parked for a human" }
            : { status: "opened", pr: "owner/repo#103", summary: "resumed and opened" };
        },
      },
      { baseBranch: "epic/e2e" },
      async ({ app, processKey }) => {
        const tasks = await app.engine.searchUserTasks({ processInstanceKey: processKey });
        const task = tasks.find((t) => t.elementId === "feature-escalation") as InboxTask | undefined;
        assert.ok(task?.userTaskKey, "the feature escalation parked a completable native user task");

        await app.engine.completeUserTask(task!.userTaskKey, { resolution: "answer", answer: "use v2" });
        await app.settle();

        const flows = takenFlows(app);
        assert.ok(
          flows.includes("w_gw_answer->implement-task"),
          `answer re-dispatched the same implement task (flows: ${flows.join(", ")})`,
        );
        assert.ok(!flows.includes("w_gw_answer->record-feature"), "the abandon (default) flow was NOT taken");
        assert.equal(calls, 2, "the implementation agent was re-dispatched exactly once after the answer");
      },
    );
  });

  test("escalate + abandon: abandoning routes to record-feature (default flow)", async () => {
    await withApp(
      {
        "senior:feature": () => ({ status: "escalated", question: "Blocked — abandon?", summary: "parked" }),
      },
      { baseBranch: "epic/e2e" },
      async ({ app, processKey }) => {
        const tasks = await app.engine.searchUserTasks({ processInstanceKey: processKey });
        const task = tasks.find((t) => t.elementId === "feature-escalation") as InboxTask | undefined;
        assert.ok(task?.userTaskKey, "the feature escalation parked a completable native user task");

        await app.engine.completeUserTask(task!.userTaskKey, { resolution: "abandon" });
        await app.settle();

        const flows = takenFlows(app);
        assert.ok(
          flows.includes("w_gw_answer->record-feature"),
          `abandon routed to record-feature (flows: ${flows.join(", ")})`,
        );
        assert.ok(!flows.includes("w_gw_answer->implement-task"), "the answer loop was NOT taken");
      },
    );
  });
});
