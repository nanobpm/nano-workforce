// End-to-end proof for agent-answerable escalations (epic #156, slice U6; ADR 0046). Boots the whole
// app against the WASM engine and drives the REAL plan-fanout.bpmn to the implementation-phase task
// escalation — the native `feature-escalation` userTask + form the human path (U2) completes — then
// completes it through the HOST-SIDE AGENT COMPLETER (`completeEscalationAsAgent`) instead of a raw
// human completion. It proves the three things U6 promises:
//
//   1. an AGENT assignee completing the SAME `.form` resumes the process with typed vars IDENTICAL to
//      a human completion — asserted on the cumulative taken sequence flows: `{resolution:"answer"}`
//      routes `w_gw_answer -> implement-task`, exactly as the U2 human test asserts (an empty/wrong
//      completion would take the abandon default);
//   2. attribution is recorded — the `task_completions` ledger row is actor_kind=agent + the agent id
//      + the submitted variables;
//   3. the completion is reversible — a human reverts it, and the ledger records who + when.
//
// No `.bpmn` is touched by this slice: the agent uses the same process + form the human does, only
// the completion CALLER differs. Network isolation mirrors the sibling e2e suites (github forced to
// offline `token` mode). Run with `npm run e2e`.

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
import {
  completeEscalationAsAgent,
  latestCompletion,
  revertAgentCompletion,
  type TaskCompletion,
} from "../app/agentCompletion.ts";

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

type Stub = (job: EngineJob) => Record<string, unknown> | void;

describe("agent-answerable escalations (U6 — same form, agent completer, attribution + reversibility)", () => {
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
    const dbDir = mkdtempSync(join(tmpdir(), "nwf-u6-"));
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

  const singleTaskPlan: Stub = () => ({ tasks: [{ id: "t1", title: "T1", prompt: "do t1" }] });
  const approveReview: Stub = () => ({ approved: true, findings: "" });

  test("an agent completes the SAME feature-escalation form a human would → process resumes with the identical typed vars, attributed, and reversible", async () => {
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

        // Complete AS AN AGENT through the host-side completer — the same typed `{resolution, answer}`
        // a human submits through the inbox, only the caller differs.
        const r = await completeEscalationAsAgent(app.db, asEngineClient(app.engine), {
          userTaskKey: task.userTaskKey,
          agentId: "senior:answer-bot",
          variables: { resolution: "answer", answer: "use v2" },
        });
        assert.equal(r.ok, true, "the agent completer accepted the escalation completion");
        assert.equal(r.elementId, "feature-escalation");
        await app.settle();

        // IDENTICAL resume to the human path (mirrors U2's human test): the typed resolution loops
        // the child back to re-dispatch the SAME task — NOT the abandon default.
        const flows = takenFlows(app);
        assert.ok(
          flows.includes("w_gw_answer->implement-task"),
          `agent answer routed back to implement-task (flows: ${flows.join(", ")})`,
        );
        assert.ok(
          !flows.includes("w_gw_answer->w_end"),
          "the abandon (default) flow was NOT taken",
        );

        // Attribution: the ledger records an AGENT completion with the agent id + the exact vars.
        const completions = await app.db
          .table<TaskCompletion>("task_completions", "id")
          .find({ user_task_key: task.userTaskKey });
        assert.equal(completions.length, 1, "exactly one attribution row for the completion");
        const row = completions[0];
        assert.equal(row.actor_kind, "agent");
        assert.equal(row.actor_id, "senior:answer-bot");
        assert.equal(row.element_id, "feature-escalation");
        assert.deepEqual(JSON.parse(row.variables_json), { resolution: "answer", answer: "use v2" });
        assert.equal(row.reversible, 1, "an agent completion is reversible");
        assert.equal(row.reverted, 0);

        // Reversibility: a human overrides the agent's answer; the ledger records who + when.
        const rev = await revertAgentCompletion(app.db, row.id, { kind: "human", id: "alice" });
        assert.equal(rev.ok, true, "a human can revert the agent completion");
        const after = (await latestCompletion(app.db, task.userTaskKey))!;
        assert.equal(after.reverted, 1);
        assert.equal(after.reverted_by, "alice");
        assert.ok(after.reverted_at, "reverted_at is stamped");
      },
    );
  });
});
