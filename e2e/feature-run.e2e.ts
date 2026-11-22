// End-to-end proof for the single-issue feature run (issue #172). Boots the whole app against the
// WASM engine and drives the REAL feature.bpmn through its three outcomes:
//   • raise-only — the agent opens a PR, `converge` is off → the run ends at `opened`, no hand-off;
//   • raise + converge — with `converge` on, the opened PR is enrolled into the convergence loop
//     (a `pull_requests` row appears) and the feature_run lands `converging`;
//   • escalate + resume — the agent escalates, the shared implement-cell spawns a `human-escalation`
//     grandchild whose native `escalation` user task parks the run, and answering re-dispatches the
//     SAME implement task inside the cell (mirrors the epic slice).
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
import { settleFully } from "./support/time.ts";
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
  process_key: string | null;
}

describe("single-issue feature run (#172 — feature.bpmn)", () => {
  const savedEnv = new Map<string, string | undefined>();
  let restoreGithub: (() => void) | undefined;
  const githubState = admitGithubState("owner/repo", "main");

  before(() => {
    for (const [k, v] of Object.entries(GITHUB_ENV_OVERRIDES)) {
      savedEnv.set(k, process.env[k]);
      process.env[k] = v;
    }
    // ADR 0003: `startFeature` + the `pr.ensure-base-branch` head task pass through base admission,
    // which reads/creates the base ref. Pin the hermetic `token` transport + fetch stub.
    restoreGithub = installAdmitGithub(githubState);
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
      // Fixpoint (not a single tick): the `converge` hand-off enrolls the opened PR via `submitPr`,
      // whose nested `createInstance` re-entrantly runs the new `capture-head` host task (#786) and
      // leaves `pr.converge-feature`'s own completion undrained until a later settle — see
      // `settleFully`.
      await settleFully(app);
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
    // Host-git provisioning (#684): capture the repository envelope the `senior:feature` agent job
    // carries — proof the implement-cell agent gets an ISOLATED clone (base branch + a harness-cut
    // `feat/<task.id>`) instead of inheriting the worker's launch dir. It rides the process variable
    // all the way down through feature.bpmn's `implement` callActivity into the cell's agent job.
    let agentTask: any = null;
    await withApp(
      {
        "senior:feature": (job) => {
          agentTask = (job.variables as Record<string, any>)["io.nanobpm.agentTask"] ?? null;
          return { status: "opened", pr: "owner/repo#101", summary: "built it" };
        },
      },
      { baseBranch: "epic/e2e" },
      async ({ app, featureKey }) => {
        const flows = takenFlows(app);
        assert.ok(
          flows.includes("gw-converge->End"),
          `converge=false took the raise-only branch (flows: ${flows.join(", ")})`,
        );
        assert.ok(!flows.includes("gw-converge->converge"), "the converge hand-off branch was NOT taken");

        assert.ok(agentTask, "the senior:feature job carried the io.nanobpm.agentTask repository envelope");
        const agentRepo = agentTask.repository;
        assert.equal(agentRepo.url, "https://github.com/owner/repo.git", "the harness clones the target repo");
        assert.equal(agentRepo.ref, "epic/e2e", "a PRE-PR job checks out the BASE branch, not a head");
        // `branch` is a TOP-LEVEL sibling of `repository` (issue #882) — the harness reads it from the root.
        assert.equal(agentTask.branch.create, "feat/issue-7", "the harness cuts the deterministic feature branch");

        const run = await featureRow(app, featureKey);
        assert.equal(run.status, "opened", "the run settled at opened");
        assert.equal(run.pr_key, "owner/repo#101", "the raised PR key was recorded");

        const prs = await app.db.table<PrRow>("pull_requests", "pr_key").find({});
        assert.equal(prs.length, 0, "raise-only did NOT enroll the PR into the convergence loop");

        // Issue #907: the HOST posted exactly one idempotent "PR opened" comment on the claimed
        // issue, and recorded the link on the run row so a repeated pass never double-posts.
        // (Snapshot the issue's comments: the github state is shared across this file's tests.)
        const comments = (githubState.issueComments.get(7) ?? []).filter((c) => c.body.includes("nwf:pr-linked:#101"));
        assert.equal(comments.length, 1, "exactly one comment was posted on the claimed issue for PR #101");
        assert.ok(comments[0].body.includes("Pull request opened: #101"), "the comment names the PR");
        assert.ok(
          comments[0].body.includes("<!-- nwf:pr-linked:#101 https://github.com/owner/repo/pull/101 -->"),
          "the comment carries the URL-keyed dedupe marker",
        );
        assert.equal(
          (run as unknown as { pr_linked_pr_key: string | null }).pr_linked_pr_key,
          "owner/repo#101",
          "the durable link record was written",
        );
      },
    );
  });

  test("idempotence: re-running record-feature for the SAME delivered PR posts nothing more (issue #907)", async () => {
    // A retried at-least-once `record-feature` job (or a second reconcile pass) must never
    // double-post the "PR opened" comment: the durable `pr_linked_pr_key` claim short-circuits the
    // repeat before any GitHub write.
    await withApp(
      { "senior:feature": () => ({ status: "opened", pr: "owner/repo#101", summary: "built it" }) },
      { baseBranch: "epic/e2e" },
      async ({ app, featureKey }) => {
        const before = (githubState.issueComments.get(7) ?? []).length;
        assert.equal(before >= 0, true);
        // Drive the REAL record-feature handler a second time with the same delivered PR (the
        // at-least-once repeat / second reconcile pass), against the SAME live app DB.
        const { default: recordFeature } = await import("../workers/record-feature/worker.ts");
        const log = { info: () => {}, warn: () => {}, error: () => {} };
        await recordFeature(
          { jobKey: "repeat-1", variables: { featureKey, status: "opened", pr: "owner/repo#101", claimIssue: true } } as never,
          { data: app.db, log } as never,
        );
        assert.equal(
          (githubState.issueComments.get(7) ?? []).length,
          before,
          "a repeated record pass posted NO second comment",
        );
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

  test("raise + converge + human approval: the enrolled convergence loop carries the approval gate (issue #826)", async () => {
    await withApp(
      { "senior:feature": () => ({ status: "opened", pr: "owner/repo#103", summary: "built it" }) },
      { baseBranch: "epic/e2e", converge: true, autoMerge: true, humanApproval: true },
      async ({ app }) => {
        // The flag must survive the real handoff: feature.bpmn → converge-cell callActivity →
        // pr.converge-feature → submitPr → the live loop instance (still ACTIVE, so its vars are readable).
        const pr = await app.db.table<PrRow>("pull_requests", "pr_key").findOne({ pr_key: "owner/repo#103" });
        assert.ok(pr?.process_key, "converge enrolled the raised PR into a live convergence loop");
        const instances = app.snapshot().instances;
        assert.ok(Array.isArray(instances), "snapshot.instances is an array of instance rows");
        const loop = instances.find((i) => i?.key === pr.process_key);
        assert.equal(loop?.variables?.humanApproval, true, "the convergence loop was seeded with humanApproval");
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
        await pollUserTasks(app.db, app.engine);
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
        await pollUserTasks(app.db, app.engine);
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
            : { status: "opened", pr: "owner/repo#104", summary: "resumed and opened" };
        },
      },
      { baseBranch: "epic/e2e" },
      async ({ app, processKey }) => {
        // The escalation user task now lives on a `human-escalation` grandchild instance the shared
        // `implement-cell` spawns (ADR 0006 S4), so it is found root-scoped, by the cell's `escalation`
        // element — not `feature-escalation` on the parent (that inline task no longer exists).
        const tasks = await app.engine.searchUserTasks({ rootProcessInstanceKey: processKey });
        const task = tasks.find((t) => t.elementId === "escalation") as InboxTask | undefined;
        assert.ok(task?.userTaskKey, "the human-escalation cell parked a completable native user task on a child instance");

        await app.engine.completeUserTask(task!.userTaskKey, { resolution: "answer", answer: "use v2" });
        await app.settle();

        const flows = takenFlows(app);
        assert.ok(
          flows.includes("ic_gw_answer->record-implementing"),
          `answer re-dispatched through the cell's implementing-reset task (flows: ${flows.join(", ")})`,
        );
        assert.ok(
          flows.includes("record-implementing->implement-task"),
          `the reset task re-enters the same implement task inside the cell (flows: ${flows.join(", ")})`,
        );
        assert.ok(!flows.includes("ic_gw_answer->ic_end"), "the abandon (default) flow was NOT taken");
        assert.equal(calls, 2, "the implementation agent was re-dispatched exactly once after the answer");

        // Issue #907: the RETRY opened the PR — the host still posted exactly one "PR opened"
        // comment on the claimed issue (the first, escalated pass delivered no PR, so nothing was
        // posted before the answer). Uses a PR number (#104) no earlier scenario links, so a pre-existing marker in the shared github state cannot satisfy this.
        const comments = (githubState.issueComments.get(7) ?? []).filter((c) => c.body.includes("nwf:pr-linked:#104"));
        assert.equal(comments.length, 1, "exactly one comment was posted across the escalate+resume");
        assert.ok(comments[0].body.includes("Pull request opened: #104"), "the comment names the retry-opened PR");
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

      const tasks = await app.engine.searchUserTasks({ rootProcessInstanceKey: parked.process_key! });
      const task = tasks.find((t) => t.elementId === "escalation") as InboxTask | undefined;
      assert.ok(task?.userTaskKey, "the human-escalation cell parked a completable native user task on a child instance");

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

  test("reconcile before escalate: a no-status result with an open PR on the branch adopts & converges (issue #801)", async () => {
    // The #796/#801 defect: a harness returns NO machine-readable status but has pushed the branch and
    // opened a green PR. Instead of dead-ending at a human, the cell's reconcile step observes the open
    // PR on `feat/<task.id>` (= `feat/issue-7`), adopts it (status=opened, prKey), and converges.
    githubState.openPrs.set("feat/issue-7", { number: 801, base: "epic/e2e" });
    try {
      await withApp(
        { "senior:feature": () => ({ summary: "opened a PR but reported no status" }) },
        { baseBranch: "epic/e2e", converge: true },
        async ({ app, featureKey }) => {
          const flows = takenFlows(app);
          assert.ok(
            flows.includes("ic_reconcile_gw->ic_end"),
            `the adopted PR routed straight to the cell's done end (flows: ${flows.join(", ")})`,
          );
          assert.ok(
            !flows.includes("ic_reconcile_gw->record-escalation"),
            "the run did NOT escalate to a human",
          );
          assert.ok(
            flows.includes("gw-converge->converge"),
            `the adopted PR was handed to the convergence loop (flows: ${flows.join(", ")})`,
          );
          const run = await featureRow(app, featureKey);
          assert.equal(run.status, "converging", "the reconciled run settled at converging");
          assert.equal(run.pr_key, "owner/repo#801", "the adopted PR key is recorded on the run");
          const prs = await app.db.table<PrRow>("pull_requests", "pr_key").find({ pr_key: "owner/repo#801" });
          assert.equal(prs.length, 1, "the adopted PR was enrolled into the convergence loop (submitPr)");

          // A native user-task escalation was never parked — the machine-recoverable outcome was
          // reconciled without pulling in a person.
          const tasks = await app.engine.searchUserTasks({ rootProcessInstanceKey: run.process_key! });
          assert.ok(
            !tasks.some((t) => t.elementId === "escalation"),
            "no human-escalation task was created for the adopted run",
          );

          // Issue #907: the ADOPTED PR was announced on the claimed issue exactly once — the
          // reconcile path delivers the PR without the agent reporting it, and the host-side link
          // covers it all the same. (Filtered to THIS PR's marker — the github state is shared.)
          const comments = (githubState.issueComments.get(7) ?? []).filter((c) => c.body.includes("nwf:pr-linked:#801"));
          assert.equal(comments.length, 1, "exactly one comment was posted for the adopted PR");
          assert.ok(comments[0].body.includes("Pull request opened: #801"), "the comment names the adopted PR");
        },
      );
    } finally {
      githubState.openPrs.delete("feat/issue-7");
    }
  });

  test("keyless opened: an `opened` result with no pr key reconciles the PR from GitHub and still converges (issue #1011)", async () => {
    // The #1011 defect: the agent opened its PR with `gh pr create` and reported `status: "opened"` but
    // left `pr` out of the envelope. `ic_gw` used to treat that as a clean finish → `pr: null` → no
    // converge-cell. Now the keyless `opened` routes through reconcile-implement, which recovers the key.
    githubState.openPrs.set("feat/issue-7", { number: 1010, base: "epic/e2e" });
    try {
      await withApp(
        { "senior:feature": () => ({ status: "opened", summary: "opened the PR but omitted the pr key" }) },
        { baseBranch: "epic/e2e", converge: true },
        async ({ app, featureKey }) => {
          const flows = takenFlows(app);
          assert.ok(!flows.includes("ic_gw->ic_end"), `the keyless opened was NOT a clean finish (flows: ${flows.join(", ")})`);
          assert.ok(flows.includes("ic_reconcile_gw->ic_end"), `the keyless opened was reconciled (flows: ${flows.join(", ")})`);
          assert.ok(flows.includes("gw-converge->converge"), `the recovered PR converged (flows: ${flows.join(", ")})`);
          const run = await featureRow(app, featureKey);
          assert.equal(run.pr_key, "owner/repo#1010", "the recovered PR key is recorded on the run");
          const prs = await app.db.table<PrRow>("pull_requests", "pr_key").find({ pr_key: "owner/repo#1010" });
          assert.equal(prs.length, 1, "the recovered PR was enrolled into the convergence loop");
        },
      );
    } finally {
      githubState.openPrs.delete("feat/issue-7");
    }
  });

  test("keyless opened: no PR on the branch escalates with lookup evidence instead of passing pr: null (issue #1011)", async () => {
    await withApp(
      { "senior:feature": () => ({ status: "opened", summary: "said it opened a PR" }) },
      { baseBranch: "epic/e2e", converge: true },
      async ({ app, featureKey }) => {
        const flows = takenFlows(app);
        assert.ok(flows.includes("ic_reconcile_gw->record-escalation"), `escalated (flows: ${flows.join(", ")})`);
        assert.ok(!flows.includes("gw-converge->converge"), "never converged a null PR");
        const run = await featureRow(app, featureKey);
        assert.equal(run.status, "escalated", "the run parked for a human");
        const rows = await app.db
          .table<{ feature_key: string; question: string }>("feature_escalations", "id")
          .find({ feature_key: featureKey });
        const q = rows.at(-1)?.question ?? "";
        assert.ok(q.includes("reported opened but no PR from feat/issue-7 into epic/e2e"), `evidence in the question: ${q}`);
      },
    );
  });

  test("keyless opened + abandon: the abandoned run is recorded NON-success, never `opened` with no PR (issue #1011 review)", async () => {
    // Abandon (and the escalation-SLA auto-abandon, which leaves human-escalation the same way and
    // takes the same ic_gw_answer default flow) ends the cell straight from the escalation. The
    // reconcile step must have rewritten the unreconciled keyless `opened` to `blocked`, so the terminal
    // record-feature never persists a delivered-looking `opened` row with `pr_key: null`.
    await withApp(
      { "senior:feature": () => ({ status: "opened", summary: "said it opened a PR" }) },
      { baseBranch: "epic/e2e" },
      async ({ app, featureKey, processKey }) => {
        const tasks = await app.engine.searchUserTasks({ rootProcessInstanceKey: processKey });
        const task = tasks.find((t) => t.elementId === "escalation") as InboxTask | undefined;
        assert.ok(task?.userTaskKey, "the keyless opened parked an escalation");
        await app.engine.completeUserTask(task!.userTaskKey, { resolution: "abandon" });
        await settleFully(app);
        const flows = takenFlows(app);
        assert.ok(flows.includes("ic_gw_answer->ic_end"), `abandon flow taken (flows: ${flows.join(", ")})`);
        const run = await featureRow(app, featureKey);
        assert.notEqual(run.status, "opened", "an abandoned keyless run is never recorded as delivered");
        assert.equal(run.pr_key, null);
      },
    );
  });

  test("blocked reconcile: a blocked report whose branch IS pushed + ahead opens the PR itself and converges (issue #967)", async () => {
    // The #967 defect, end to end: the agent reports `blocked` ("complete and committed LOCALLY …
    // cut off before I could push") but the branch IS on the remote (at the agent's own reported
    // headSha) and ahead of base — only the PR step is missing. The run must reconcile with the
    // remote, open the PR from the branch, and continue to converge — NEVER park in the human inbox.
    //
    // PR #968 review (round 2): driven THROUGH auto-merge — the run carries `autoMerge: true`, so
    // the recovered DRAFT PR is enrolled with merge intent. That intent is what hands the PR to the
    // merge stage (`finalize → startMerge → pollMerges`), where the new promote-after-validation
    // path (`draftPromotionReady` + `markPullRequestReady`) un-drafts the now-converged, green draft
    // so it lands without a human "mark it ready" escalation. This test asserts the enrolment carries
    // the merge intent (the handoff that reaches that path); the promotion itself is unit-pinned in
    // app/mergeProtocol.test.ts (draftPromotionReady) and app/github.test.ts (markPullRequestReady),
    // because this hermetic suite seals GitHub to the token transport, which cannot enumerate checks.
    githubState.branches.set("feat/issue-7", "f".repeat(40));
    githubState.comparisons.set("epic/e2e...feat/issue-7", { status: "ahead", ahead_by: 2, behind_by: 0 });
    try {
      await withApp(
        // The fake agent result says "blocked" while the remote branch exists — exactly the
        // regression case the issue demands. The agent's self-reported headSha rides the reserved
        // `io.nanobpm.agentResult` envelope (context only; the remote is the authority).
        {
          "senior:feature": () => ({
            status: "blocked",
            summary: "complete and committed LOCALLY — cut off before I could push",
            "io.nanobpm.agentResult": { headSha: "f".repeat(40), exitCode: 0 },
          }),
        },
        { baseBranch: "epic/e2e", converge: true, autoMerge: true },
        async ({ app, featureKey }) => {
          const flows = takenFlows(app);
          assert.ok(
            !flows.includes("gw-blocked->feature-blocked"),
            `the run did NOT park on the operator inbox (flows: ${flows.join(", ")})`,
          );
          assert.ok(
            flows.includes("gw-converge->converge"),
            `the reconciled PR was handed to the convergence loop (flows: ${flows.join(", ")})`,
          );

          // The host opened exactly one PR THIS run (the shared stub state accumulates across the
          // file's tests — snapshot the delta), from the agent's branch onto the run's base, as a
          // DRAFT (the agent never vouched for it), linking the issue with a non-blocking ref.
          const mine = githubState.createdPrs.filter((p) => p.head === "feat/issue-7");
          assert.equal(mine.length, 1, "exactly one PR was opened by the reconcile");
          const created = mine[0];
          assert.equal(created.head, "feat/issue-7", "the PR was opened FROM the agent's pushed branch");
          assert.equal(created.base, "epic/e2e", "the PR targets the run's base branch");
          assert.equal(created.draft, true, "a reconcile-opened PR is a draft");
          assert.ok(created.body.includes("Refs owner/repo#7"), "the PR links the issue non-blockingly");

          const run = await featureRow(app, featureKey);
          assert.equal(run.status, "converging", "the run settled at converging, never blocked");
          assert.equal(run.pr_key, `owner/repo#${created.number}`, "the opened PR key is recorded on the run");
          const prs = await app.db.table<PrRow>("pull_requests", "pr_key").find({ pr_key: run.pr_key! });
          assert.equal(prs.length, 1, "the reconcile-opened PR was enrolled into the convergence loop");

          // THROUGH AUTO-MERGE (PR #968 review): the recovered DRAFT PR's convergence loop is seeded
          // with the merge intent (`autoMerge: true`), so on convergence it hands off to the merge
          // stage — where the promote-after-validation path un-drafts the converged, green draft and
          // lands it without a human. Read the still-ACTIVE loop's variables (a completed instance
          // folds them away) to prove the intent survived the reconcile → submitPr handoff.
          const instances = app.snapshot().instances;
          assert.ok(Array.isArray(instances), "snapshot.instances is an array of instance rows");
          const loop = instances.find((i) => i?.key === prs[0].process_key);
          assert.ok(loop, "the recovered PR's convergence loop is live");
          assert.equal(
            loop?.variables?.autoMerge,
            true,
            "the recovered draft PR was enrolled with autoMerge intent (reaches the merge stage's draft promotion)",
          );

          // No human task was ever parked.
          const tasks = await app.engine.searchUserTasks({ rootProcessInstanceKey: run.process_key! });
          assert.ok(
            !tasks.some((t) => t.elementId === "feature-blocked"),
            "no feature-blocked operator task was created",
          );
        },
      );
    } finally {
      githubState.branches.delete("feat/issue-7");
      githubState.comparisons.delete("epic/e2e...feat/issue-7");
    }
  });

  test("blocked reconcile: a blocked report whose branch already has an OPEN PR adopts it (issue #967)", async () => {
    // The agent pushed the branch AND opened the PR, then misreported `blocked`. The reconcile
    // adopts the existing PR (never opens a duplicate) and converges.
    githubState.branches.set("feat/issue-7", "f".repeat(40));
    githubState.openPrs.set("feat/issue-7", { number: 967, base: "epic/e2e" });
    const createsBefore = githubState.createdPrs.length;
    try {
      await withApp(
        { "senior:feature": () => ({ status: "blocked", summary: "stuck" }) },
        { baseBranch: "epic/e2e", converge: true },
        async ({ app, featureKey }) => {
          const flows = takenFlows(app);
          assert.ok(!flows.includes("gw-blocked->feature-blocked"), "the run did NOT park on the operator inbox");
          assert.ok(flows.includes("gw-converge->converge"), "the adopted PR was handed to the convergence loop");
          assert.equal(
            githubState.createdPrs.length,
            createsBefore,
            "no duplicate PR was opened — the existing one was adopted",
          );

          const run = await featureRow(app, featureKey);
          assert.equal(run.status, "converging");
          assert.equal(run.pr_key, "owner/repo#967", "the adopted PR key is recorded on the run");

          // Issue #907: the adopted PR was announced on the claimed issue exactly once.
          const comments = (githubState.issueComments.get(7) ?? []).filter((c) => c.body.includes("nwf:pr-linked:#967"));
          assert.equal(comments.length, 1, "exactly one comment was posted for the adopted PR");
        },
      );
    } finally {
      githubState.branches.delete("feat/issue-7");
      githubState.openPrs.delete("feat/issue-7");
    }
  });

  test("blocked reconcile: a blocked report with NOTHING on the remote still parks for a human (issue #967)", async () => {
    // Escalate ONLY when there is no commit to deliver: no branch on the remote → the run parks at
    // `feature-blocked` exactly as before the fix, and no PR is opened.
    const createsBefore = githubState.createdPrs.length;
    await withApp(
      { "senior:feature": () => ({ status: "blocked", summary: "could not proceed" }) },
      { baseBranch: "epic/e2e", converge: true },
      async ({ app, featureKey, processKey }) => {
        const flows = takenFlows(app);
        assert.ok(
          flows.includes("gw-blocked->feature-blocked"),
          `a genuinely undelivered run still routes to the operators (flows: ${flows.join(", ")})`,
        );
        assert.equal(githubState.createdPrs.length, createsBefore, "no PR was opened for an empty remote");

        const tasks = await app.engine.searchUserTasks({ processInstanceKey: processKey });
        const task = tasks.find((t) => t.elementId === "feature-blocked") as InboxTask | undefined;
        assert.ok(task?.userTaskKey, "the run parked a completable feature-blocked task");
        const parked = await featureRow(app, featureKey);
        assert.equal(parked.status, "awaiting_operator", "the run is non-terminal awaiting_operator while parked");
        assert.equal(parked.pr_key, null);
      },
    );
  });

  test("blocked reconcile: a pushed branch with NOTHING over base still parks for a human (issue #967)", async () => {
    // The branch exists on the remote but carries no commit over base (identical) — there is no
    // commit to deliver, so the run escalates rather than opening an empty PR.
    githubState.branches.set("feat/issue-7", "0".repeat(40));
    githubState.comparisons.set("epic/e2e...feat/issue-7", { status: "identical", ahead_by: 0, behind_by: 0 });
    const createsBefore = githubState.createdPrs.length;
    try {
      await withApp(
        { "senior:feature": () => ({ status: "blocked", summary: "branched but never committed" }) },
        { baseBranch: "epic/e2e", converge: true },
        async ({ app, featureKey, processKey }) => {
          const flows = takenFlows(app);
          assert.ok(flows.includes("gw-blocked->feature-blocked"), "a branch with nothing over base still escalates");
          assert.equal(githubState.createdPrs.length, createsBefore, "an empty PR was never opened");
          const tasks = await app.engine.searchUserTasks({ processInstanceKey: processKey });
          assert.ok(
            tasks.some((t) => t.elementId === "feature-blocked"),
            "the run parked on the operator inbox",
          );
          const parked = await featureRow(app, featureKey);
          assert.equal(parked.status, "awaiting_operator");
        },
      );
    } finally {
      githubState.branches.delete("feat/issue-7");
      githubState.comparisons.delete("epic/e2e...feat/issue-7");
    }
  });

  test("escalate + abandon: abandoning routes to record-feature (default flow)", async () => {
    await withApp(
      {
        "senior:feature": () => ({ status: "escalated", question: "Blocked — abandon?", summary: "parked" }),
      },
      { baseBranch: "epic/e2e" },
      async ({ app, processKey }) => {
        const tasks = await app.engine.searchUserTasks({ rootProcessInstanceKey: processKey });
        const task = tasks.find((t) => t.elementId === "escalation") as InboxTask | undefined;
        assert.ok(task?.userTaskKey, "the human-escalation cell parked a completable native user task on a child instance");

        await app.engine.completeUserTask(task!.userTaskKey, { resolution: "abandon" });
        await app.settle();

        const flows = takenFlows(app);
        assert.ok(
          flows.includes("ic_gw_answer->ic_end"),
          `abandon took the cell's default abandon flow to the task-done end (flows: ${flows.join(", ")})`,
        );
        assert.ok(!flows.includes("ic_gw_answer->record-implementing"), "the answer loop was NOT taken");
        // The abandoned cell completes and the parent routes to its terminal recorder exactly once.
        assert.ok(
          flows.includes("implement->record-feature"),
          `the completed cell routes the parent to record-feature (flows: ${flows.join(", ")})`,
        );
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
        // The cell's `record-escalation` service task runs on the escalated arm (before the human task),
        // so the row already carries the flipped status when the run parks, and the agent's question is
        // recorded in the `feature_escalations` audit log the poller reads (issue #332 dropped the
        // denormalised `feature_runs.escalation_question` column).
        const parked = await featureRow(app, featureKey);
        assert.equal(parked.status, "escalated", "the escalated status is surfaced on the read model");

        // The escalation parks on a `human-escalation` grandchild instance (ADR 0006 S4), so it is found
        // root-scoped, by the cell's `escalation` element — the reduced-path poller correlates that
        // grandchild task back to the feature subject via its rootProcessInstanceKey (real child execution).
        const tasks = await app.engine.searchUserTasks({ rootProcessInstanceKey: processKey });
        const task = tasks.find((t) => t.elementId === "escalation") as InboxTask | undefined;
        assert.ok(task?.userTaskKey, "the human-escalation cell parked a completable native user task on a child instance");

        // The poller projects the parked task onto the Tasks inbox `user_tasks` read-model by reading
        // the engine directly, sourcing the question from the `feature_escalations` audit log.
        await pollUserTasks(app.db, app.engine);
        const inboxRow = await app.db
          .table<{ user_task_key: string; element_id: string; question: string | null }>("user_tasks", "user_task_key")
          .findOne({ user_task_key: task!.userTaskKey });
        assert.ok(inboxRow, "the poller projected the escalation onto the Tasks inbox read-model");
        // The recorder enriches the agent's own question with its summary as supporting context
        // (issue #865 review) — the audit log carries the leading question AND the appended summary, and
        // `pollUserTasks` surfaces that enriched text unchanged.
        assert.equal(
          inboxRow!.question,
          'Which API should I use? The agent\'s own summary: "parked for a human".',
          "the agent's question, enriched with its summary, is surfaced from the audit log",
        );

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
          flows.includes("ic_gw_answer->record-implementing") &&
            flows.includes("record-implementing->implement-task"),
          `the answer re-dispatched the same implement task through the cell's reset (flows: ${flows.join(", ")})`,
        );
        assert.equal(calls, 2, "the implementation agent was re-dispatched exactly once after the answer");

        // The run opened its PR.
        const settled = await featureRow(app, featureKey);
        assert.equal(settled.status, "opened", "the resumed run opened its PR");

        // A further poll pass reconciles the completed task's read-model row away.
        await pollUserTasks(app.db, app.engine);
        const gone = await app.db
          .table<{ user_task_key: string }>("user_tasks", "user_task_key")
          .findOne({ user_task_key: task!.userTaskKey });
        assert.equal(gone, undefined, "the completed escalation's inbox row was reconciled away");
        assert.equal((await featureRow(app, featureKey)).status, "opened");
      },
    );
  });
});
