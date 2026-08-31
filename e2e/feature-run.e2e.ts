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
import { asEngineClient } from "./support/engine-client.ts";
import { pollUserTasks } from "../app/service.ts";

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

        // The escalation state now lives on the native user task + the Tasks inbox `user_tasks`
        // read-model (issue #332 dropped the denormalised `feature_runs.blocked_user_task_key` pointer),
        // so `pollUserTasks` projects the parked `feature-blocked` task onto `user_tasks` by reading the
        // engine directly — no per-run column write.
        await pollUserTasks(app.db, asEngineClient(app.engine));
        const inboxRow = await app.db
          .table<{ user_task_key: string; element_id: string }>("user_tasks", "user_task_key")
          .findOne({ user_task_key: task!.userTaskKey });
        assert.ok(inboxRow, "the poller projected the blocked task onto the Tasks inbox read-model");
        assert.equal(inboxRow!.element_id, "feature-blocked", "the projected row is a feature-blocked task");
        assert.equal(parked.status, "awaiting_operator", "the run stays awaiting_operator while parked");

        // Acknowledge through the ONE canonical `complete-user-task` door (issue #332 retired the bespoke
        // `acknowledge-blocked` operation) — the attributed human completer resumes the SAME
        // record-blocked-ack path from the task inbox, with NO out-of-band completion call.
        const acked = await app.api?.call("completeUserTask", {
          body: { userTaskKey: task!.userTaskKey, variables: { note: "reassigned to a human" } },
        });
        assert.equal(acked?.status, 200, "the operator acknowledgement completed the blocked task");
        await app.settle();
        const flows2 = takenFlows(app);
        assert.ok(flows2.includes("feature-blocked->record-blocked-ack"), "ack routes through record-blocked-ack");
        assert.ok(flows2.includes("record-blocked-ack->End"), "the acknowledged run ends");
        const settled = await featureRow(app, featureKey);
        assert.equal(settled.status, "blocked", "the acknowledged run settles at terminal blocked");
        assert.equal(settled.delivery_label, "operator: reassigned to a human", "the operator note is recorded");

        // A further poll pass is an idempotent no-op — the task is completed, so the read-model row is
        // reconciled away and a terminal run is not a candidate.
        await pollUserTasks(app.db, asEngineClient(app.engine));
        assert.equal((await featureRow(app, featureKey)).status, "blocked");
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
          flows.includes("w_gw_answer->record-feature-implementing"),
          `answer re-dispatched through the implementing-reset task (flows: ${flows.join(", ")})`,
        );
        assert.ok(
          flows.includes("record-feature-implementing->implement-task"),
          `the reset task re-enters the same implement task (flows: ${flows.join(", ")})`,
        );
        assert.ok(!flows.includes("w_gw_answer->record-feature"), "the abandon (default) flow was NOT taken");
        assert.equal(calls, 2, "the implementation agent was re-dispatched exactly once after the answer");
      },
    );
  });

  test("escalate + answer: the run reads `running` (not a stale escalated) through the post-answer re-implementation (issue #642)", async () => {
    // The write-side twin of `record-feature-escalation`: `record-feature-implementing` sits on the
    // answer loop-back and stamps `running` BEFORE implement-task re-runs, so `feature_runs.status` no
    // longer holds a stale `escalated` for the entire re-implementation (the #632 tear). Assert the
    // agent observes `running` at the moment it is re-dispatched. Boots inline (not `withApp`) so the
    // re-implementation stub can read the row through `app.db`.
    const dbDir = mkdtempSync(join(tmpdir(), "nwf-f642-"));
    const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dbDir, "app.db")}` } });
    try {
      let calls = 0;
      let statusDuringReimpl: string | undefined;
      await app.engine.registerWorker("senior:feature", async () => {
        calls += 1;
        if (calls === 1) {
          return { status: "escalated", question: "Which API should I use?", summary: "parked for a human" };
        }
        const run = await app.db
          .table<FeatureRow>("feature_runs", "feature_key")
          .findOne({ feature_key: "owner/repo#7" });
        statusDuringReimpl = run?.status;
        return { status: "opened", pr: "owner/repo#642", summary: "resumed and opened" };
      });
      const featureKey = "owner/repo#7";
      const started = await app.api?.call("startFeature", { body: { issue: featureKey, baseBranch: "epic/e2e" } });
      assert.equal(started?.status, 202, "startFeature accepted the issue");
      await app.settle();

      const parked = await featureRow(app, featureKey);
      assert.equal(parked.status, "escalated", "the run parks at escalated while awaiting the answer");
      assert.ok(parked.process_key, "the parked run carries its engine process-instance key");

      const tasks = await app.engine.searchUserTasks({ processInstanceKey: parked.process_key! });
      const task = tasks.find((t) => t.elementId === "feature-escalation") as InboxTask | undefined;
      assert.ok(task?.userTaskKey, "the feature escalation parked a completable native user task");

      await app.engine.completeUserTask(task!.userTaskKey, { resolution: "answer", answer: "use v2" });
      await app.settle();

      assert.equal(
        statusDuringReimpl,
        "running",
        "the reset task stamped `running` before implement-task re-ran — no stale escalated",
      );
      assert.equal(calls, 2, "the implementation agent was re-dispatched exactly once after the answer");
    } finally {
      await app.stop();
      rmSync(dbDir, { recursive: true, force: true });
    }
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
        assert.ok(!flows.includes("w_gw_answer->record-feature-implementing"), "the answer loop was NOT taken");
      },
    );
  });

  test("escalate → the poller surfaces it on the Tasks inbox, and the operator answer resolves it (issue #210/#332)", async () => {
    let calls = 0;
    await withApp(
      {
        "senior:feature": () => {
          calls += 1;
          return calls === 1
            ? { status: "escalated", question: "Which API should I use?", summary: "parked for a human" }
            : { status: "opened", pr: "owner/repo#210", summary: "resumed and opened" };
        },
      },
      { baseBranch: "epic/e2e" },
      async ({ app, featureKey, processKey }) => {
        // The `record-feature-escalation` service task runs on the escalated arm (before the user task),
        // so the row already carries the flipped status when the run parks, and the agent's question is
        // recorded in the `feature_escalations` audit log the poller reads (issue #332 dropped the
        // denormalised `feature_runs.escalation_question` column).
        const parked = await featureRow(app, featureKey);
        assert.equal(parked.status, "escalated", "the escalated status is surfaced on the read model");

        const tasks = await app.engine.searchUserTasks({ processInstanceKey: processKey });
        const task = tasks.find((t) => t.elementId === "feature-escalation") as InboxTask | undefined;
        assert.ok(task?.userTaskKey, "the feature escalation parked a completable native user task");

        // The poller projects the parked task onto the Tasks inbox `user_tasks` read-model by reading
        // the engine directly, sourcing the question from the `feature_escalations` audit log.
        await pollUserTasks(app.db, asEngineClient(app.engine));
        const inboxRow = await app.db
          .table<{ user_task_key: string; element_id: string; question: string | null }>("user_tasks", "user_task_key")
          .findOne({ user_task_key: task!.userTaskKey });
        assert.ok(inboxRow, "the poller projected the escalation onto the Tasks inbox read-model");
        assert.equal(inboxRow!.question, "Which API should I use?", "the agent's question is surfaced from the audit log");

        // Answer through the ONE canonical `complete-user-task` door (issue #332 retired the bespoke
        // `answer-escalation` operation) — the attributed human completer resumes the SAME implement task
        // a human would from the task inbox.
        const answered = await app.api?.call("completeUserTask", {
          body: { userTaskKey: task!.userTaskKey, variables: { resolution: "answer", answer: "use v2" } },
        });
        assert.equal(answered?.status, 200, "the operator answer completed the escalation task");
        await app.settle();

        const flows = takenFlows(app);
        assert.ok(
          flows.includes("w_gw_answer->record-feature-implementing") &&
            flows.includes("record-feature-implementing->implement-task"),
          `the answer re-dispatched the same implement task through the reset (flows: ${flows.join(", ")})`,
        );
        assert.equal(calls, 2, "the implementation agent was re-dispatched exactly once after the answer");

        // The run opened its PR.
        const settled = await featureRow(app, featureKey);
        assert.equal(settled.status, "opened", "the resumed run opened its PR");

        // A further poll pass reconciles the completed task's read-model row away.
        await pollUserTasks(app.db, asEngineClient(app.engine));
        const gone = await app.db
          .table<{ user_task_key: string }>("user_tasks", "user_task_key")
          .findOne({ user_task_key: task!.userTaskKey });
        assert.equal(gone, undefined, "the completed escalation's inbox row was reconciled away");
        assert.equal((await featureRow(app, featureKey)).status, "opened");
      },
    );
  });
});
