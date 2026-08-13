// Migration-path regression proof for retiring the bespoke escalation subsystem (epic #156, slice
// U7 — the destructive CONTRACT phase). Boots the whole app against the WASM engine so migration
// `027_retire_escalation_subsystem.sql` is applied on top of the full ledger, then proves three
// things about the retired surface:
//
//   1. Schema contract — the superseded tables (`plan_escalations`, `plan_review_escalations`) and
//      the denormalised pointer columns (`pull_requests.open_escalation_*`, `plans.open_task_*` /
//      `open_plan_*`) are GONE, while the kept audit surface (`escalations`) survives intact. This
//      is the falsifiable core of the contract phase — an over-drop or an un-applied migration
//      fails here.
//   2. No resurrected answer surface — the retired out-of-band answer webhooks
//      (`/app/api/hooks/feature-answer`, `/app/api/hooks/plan-answer`) 404. The task inbox is now
//      the single answer place; a stray bespoke route must not linger.
//   3. Post-migration round-trip — an escalation still round-trips through a native `userTask` + the
//      task inbox with the drained-old / re-issued-new path intact: the open escalation is DERIVED
//      from the `escalations` audit row (no denormalised pointer resurfaces), answering it via the
//      inbox resumes the loop, and no addressed escalation lingers afterwards.
//
// Run with `npm run e2e`.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DB_DIR = mkdtempSync(join(tmpdir(), "nwf-u7-"));

const GITHUB_ENV_OVERRIDES: Record<string, string> = {
  NANO_PR_GITHUB_TRANSPORT: "token",
  GITHUB_TOKEN: "",
};
const savedEnv = new Map<string, string | undefined>();

const HARNESS_ENV = {
  NANO_APP_DB_URL: `file:${join(DB_DIR, "app.db")}`,
} as const;

interface InboxTask {
  userTaskKey: string;
  elementId?: string;
  variables?: Record<string, unknown>;
}

interface StatusBody {
  prs: Array<{ prKey: string; status: string; openEscalation: string | null }>;
}

interface TableInfoRow {
  name: string;
}

interface MasterRow {
  name: string;
}

async function columnNames(app: TestApp, table: string): Promise<string[]> {
  const rows = await app.db.open().query<TableInfoRow>(`PRAGMA table_info(${table})`);
  return rows.map((r) => r.name);
}

async function tableExists(app: TestApp, table: string): Promise<boolean> {
  const rows = await app.db
    .open()
    .query<MasterRow>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
  return rows.length > 0;
}

describe("retire escalation subsystem (U7 — destructive contract phase)", () => {
  let app: TestApp;
  let reviewCalls = 0;
  let capturedAnswer: unknown;

  before(async () => {
    for (const [k, v] of Object.entries(GITHUB_ENV_OVERRIDES)) {
      savedEnv.set(k, process.env[k]);
      process.env[k] = v;
    }
    app = await bootTestApp(APP_ROOT, { env: HARNESS_ENV });
    await app.engine.registerWorker("senior:pr-review", (job) => {
      reviewCalls += 1;
      if (reviewCalls === 1) {
        return { status: "needs_input", summary: "need a human decision", question: "Which retry cap?" };
      }
      capturedAnswer = (job.variables as Record<string, unknown>).answer;
      return { status: "converged", summary: "resolved after the human answer" };
    });
  });

  after(async () => {
    await app?.stop();
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(DB_DIR, { recursive: true, force: true });
  });

  test("migration 023 drops the superseded tables and denormalised columns but keeps the audit surface", async () => {
    // The retirement migration is recorded in the ledger (it actually ran on top of the full stack).
    const applied = app.db.source().migrationsApplied;
    assert.ok(
      applied.some((m) => m.includes("027_retire_escalation_subsystem")),
      `migration 023 is in the applied ledger (applied: ${applied.join(", ")})`,
    );

    // Superseded escalation tables are gone.
    assert.equal(await tableExists(app, "plan_escalations"), false, "plan_escalations table dropped");
    assert.equal(
      await tableExists(app, "plan_review_escalations"),
      false,
      "plan_review_escalations table dropped",
    );

    // Denormalised pointer columns on pull_requests are gone (the open escalation is derived, not stored).
    const prCols = await columnNames(app, "pull_requests");
    assert.ok(prCols.length > 0, "pull_requests table still exists");
    for (const dropped of ["open_escalation_id", "open_escalation_question"]) {
      assert.ok(!prCols.includes(dropped), `pull_requests.${dropped} column dropped`);
    }

    // Denormalised pointer columns on plans are gone.
    const planCols = await columnNames(app, "plans");
    assert.ok(planCols.length > 0, "plans table still exists");
    for (const dropped of [
      "open_task_escalation_id",
      "open_task_question",
      "open_task_corr_key",
      "open_task_id",
      "open_plan_escalation_id",
      "open_plan_findings",
      "open_plan_round",
    ]) {
      assert.ok(!planCols.includes(dropped), `plans.${dropped} column dropped`);
    }

    // The kept audit surface survives — over-dropping it would break the merge-loop escalation.
    assert.equal(await tableExists(app, "escalations"), true, "escalations audit table is retained");
    const escCols = await columnNames(app, "escalations");
    assert.ok(escCols.includes("pr_key"), "escalations retains its pr_key column");
    assert.ok(escCols.includes("question"), "escalations retains its question column");
  });

  test("the retired out-of-band answer webhooks are gone — the task inbox is the single answer place", async () => {
    for (const path of ["/app/api/hooks/feature-answer", "/app/api/hooks/plan-answer"]) {
      const res = await app.callRoute({
        method: "POST",
        path,
        body: JSON.stringify({ answer: "x" }),
      });
      assert.equal(res.status, 404, `retired webhook ${path} is unmounted (404)`);
    }
  });

  test("an escalation still round-trips via userTask + inbox with no denormalised pointer or dead form", async () => {
    const api = app.api;
    assert.ok(api, "the OpenAPI driver is available");

    const prKey = "acme/widgets#701";
    const started = await api.call<{ prKey: string }>("startConvergenceLoop", {
      body: { pr: prKey, convergeOnly: true },
    });
    assert.equal(started.status, 202, "start returns 202 Accepted");

    const prs = app.db.table<{ pr_key: string; status: string; process_key: string | null }>(
      "pull_requests",
      "pr_key",
    );
    const row = await prs.findOne({ pr_key: prKey });
    assert.ok(row?.process_key, "the PR row carries the engine process-instance key");
    const processInstanceKey = row!.process_key!;

    // Drain the first review round: it parks on the native `wait-answer` userTask.
    await app.settle();

    // The escalation is a native userTask surfaced through the inbox — not a bespoke answer form.
    const listed = await app.callRoute<InboxTask[]>({
      method: "GET",
      path: "/tasks/api/tasks",
      query: { processInstanceKey },
    });
    assert.equal(listed.status, 200, "the taskInbox surface serves the task list");
    assert.equal(listed.body.length, 1, "exactly one escalation userTask is open");
    const task = listed.body[0];
    assert.equal(task.elementId, "wait-answer", "the open task is the review-loop escalation userTask");
    assert.ok(task.userTaskKey, "the task carries a completable userTaskKey");

    // The open escalation is DERIVED from the durable audit row — no denormalised pointer is written.
    const status = await app.callRoute<StatusBody>({ method: "GET", path: "/app/api/status" });
    const statusRow = status.body.prs.find((p) => p.prKey === prKey);
    assert.equal(statusRow?.status, "escalated", "the PR reads as escalated");
    assert.equal(
      statusRow?.openEscalation,
      "Which retry cap?",
      "the open escalation question is derived from the escalations audit row",
    );

    // Answer through the inbox completion route with the typed `answer` (the re-issued-new path).
    const answer = "Cap the retries at 5 and proceed.";
    const completed = await app.callRoute<{ ok: boolean }>({
      method: "POST",
      path: "/tasks/api/complete",
      body: JSON.stringify({ userTaskKey: task.userTaskKey, variables: { answer } }),
    });
    assert.equal(completed.status, 200, "the completion route accepts the typed submission");
    assert.equal(completed.body.ok, true, "the userTask was completed");

    // The answer resumed the loop and reached the resumed review round (drained-old path).
    await app.settle();
    assert.equal(reviewCalls, 2, "the review agent ran a second round after the answer");
    assert.equal(capturedAnswer, answer, "the typed answer reached the resumed review round");

    // No addressed escalation lingers — the audit row is the single source of truth.
    const afterStatus = await app.callRoute<StatusBody>({ method: "GET", path: "/app/api/status" });
    const afterRow = afterStatus.body.prs.find((p) => p.prKey === prKey);
    if (afterRow) {
      assert.equal(afterRow.openEscalation, null, "no open escalation lingers after the answer");
    }
  });
});
