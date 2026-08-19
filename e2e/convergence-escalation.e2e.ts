// End-to-end proof for the PR review-loop escalation → native userTask + form (epic #156, slice
// U4, issues #597/#599). Boots this whole Urban app in-process against the WASM engine via
// `bootTestApp` and proves the migrated escalation round-trip:
//
//   start convergence-loop → the review agent returns `needs_input` with a question → the loop
//   parks on the native `wait-answer` userTask (linked to `pr-escalation.form`), NOT the retired
//   `escalation-answered` message catch → the open escalation is derived from the durable
//   `escalations` audit row (surfaced on GET /app/api/status as `openEscalation`, with NO
//   denormalised PR-row pointer) → an operator completes the task through the taskInbox surface
//   with the typed `{ answer }` → the `record-answer` step retires the escalations row to
//   `answered` and the loop resumes and the answer reaches the next review round.
//
// The falsifiable core (mirroring the U0 spine e2e): the WASM engine folds a completed instance's
// variables away, so "resumes WITH the typed answer" is proven by capturing `job.variables.answer`
// on the review agent's SECOND activation — an empty/wrong completion would surface a different
// value. The `senior:pr-review` task is an `externalTaskType` (no app worker), so the test
// registers a stateful stub for it: needs_input first, converged (capturing the answer) second.
//
// Network isolation mirrors the sibling convergence e2e: the app's GitHub transport is forced to
// `token` mode with no token, so any best-effort GitHub read short-circuits instead of reaching out.
//
// Run with `npm run e2e` (a dedicated node:test invocation, kept out of the fast unit `npm test`).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertThatResponse, bootTestApp, type TestApp } from "@nanobpm/urban-testkit";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DB_DIR = mkdtempSync(join(tmpdir(), "nwf-u4-"));

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

describe("nano-workforce PR review-loop escalation (U4 userTask)", () => {
  let app: TestApp;
  // The review agent stub's captured state across activations.
  let reviewCalls = 0;
  let capturedAnswer: unknown;

  before(async () => {
    for (const [k, v] of Object.entries(GITHUB_ENV_OVERRIDES)) {
      savedEnv.set(k, process.env[k]);
      process.env[k] = v;
    }
    app = await bootTestApp(APP_ROOT, { env: HARNESS_ENV });
    // `senior:pr-review` is an externalTaskType (no app worker), so register a stateful stub:
    // round 1 escalates (needs_input + question); round 2 captures the resume `answer` and converges.
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

  test("a review-loop escalation parks on a userTask; completing it with {answer} resumes the loop", async () => {
    const api = app.api;
    assert.ok(api, "the OpenAPI driver is available");

    const prKey = "acme/widgets#77";
    const started = await api.call<{ prKey: string }>("startConvergenceLoop", {
      body: { pr: prKey, convergeOnly: true },
    });
    assertThatResponse(started).hasStatus(202);

    const prs = app.db.table<{ pr_key: string; status: string; process_key: string | null }>(
      "pull_requests",
      "pr_key",
    );
    const row = await prs.findOne({ pr_key: prKey });
    assert.ok(row?.process_key, "the PR row carries the engine process-instance key");
    const processInstanceKey = row!.process_key!;

    // Drain the first review round: needs_input routes through persist-escalation (which sets the
    // PR `escalated` and returns the `question`) and parks on the native `wait-answer` userTask.
    await app.settle();
    assert.equal(reviewCalls, 1, "the review agent ran exactly once before parking");

    // The escalation is a native userTask — visible through the taskInbox surface, NOT a message wait.
    const listed = await app.callRoute<InboxTask[]>({
      method: "GET",
      path: "/tasks/api/tasks",
      query: { processInstanceKey },
    });
    assertThatResponse(listed).hasStatus(200);
    assert.equal(listed.body.length, 1, "exactly one escalation userTask is open");
    const task = listed.body[0];
    assert.equal(task.elementId, "wait-answer", "the open task is the review-loop escalation userTask");
    assert.ok(task.userTaskKey, "the task carries a completable userTaskKey");

    // The open escalation is DERIVED from the durable `escalations` audit row on the status
    // endpoint — no denormalised `open_escalation_*` pointer is written or read.
    const status = await app.callRoute<StatusBody>({ method: "GET", path: "/app/api/status" });
    assertThatResponse(status).hasStatus(200);
    const statusRow = status.body.prs.find((p) => p.prKey === prKey);
    assert.ok(statusRow, "the escalated PR is listed as active");
    assert.equal(statusRow?.status, "escalated", "the PR reads as escalated");
    assert.equal(
      statusRow?.openEscalation,
      "Which retry cap?",
      "the open escalation question is derived from the open escalations row",
    );

    // Complete the escalation through the taskInbox completion route with the typed `answer`.
    const answer = "Cap the retries at 5 and proceed.";
    const completed = await app.callRoute<{ ok: boolean }>({
      method: "POST",
      path: "/tasks/api/complete",
      body: JSON.stringify({ userTaskKey: task.userTaskKey, variables: { answer } }),
    });
    assertThatResponse(completed).hasStatus(200).hasJson({ ok: true });

    // The typed answer resumed the loop back into the review round: the token took
    // wait-answer → record-answer (which retires the escalations row) → review-round, and the
    // review agent saw exactly the submitted answer. An empty or wrong completion would surface a
    // different `capturedAnswer` — this is the falsifiable core.
    await app.settle();
    const flows = takenFlows(app);
    assert.ok(
      flows.includes("wait-answer->record-answer") && flows.includes("record-answer->review-round"),
      `the answer resumed the loop through record-answer back to the review round (flows: ${flows.join(", ")})`,
    );
    assert.equal(reviewCalls, 2, "the review agent ran a second round after the answer");
    assert.equal(capturedAnswer, answer, "the typed answer reached the resumed review round");

    // The escalations row was retired to `answered` (the single source of truth the status endpoint
    // derives from), so no open escalation lingers on the status endpoint once answered + resumed.
    const afterStatus = await app.callRoute<StatusBody>({ method: "GET", path: "/app/api/status" });
    const afterRow = afterStatus.body.prs.find((p) => p.prKey === prKey);
    if (afterRow) {
      assert.equal(afterRow.openEscalation, null, "no open escalation lingers after the answer");
    }
  });
});
