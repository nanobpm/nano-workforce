// End-to-end proof for the escalation-steward orchestration (issue #889 review — the "Previously
// missed" advisory). The steward's collect/record handlers are unit-tested directly, but the BPMN
// model that wires them (`resources/processes/escalation-steward.bpmn`) had no engine-level behavior
// test: a wrong `claimed`→`claimedTasks` ioMapping, an inverted `eligibleCount > 0` gateway condition,
// or a mis-registered `pr.escalation-steward-*` / `senior:escalation-steward` task would pass every
// handler unit test while the deployed process mis-routes. This boots the whole Urban app in-process
// against the WASM engine via `bootTestApp` and drives the deployed process end-to-end:
//
//   • NO-ELIGIBLE branch — a steward tick with no opted-in escalation takes the gateway's `default`
//     (`gw_any -> done`), dispatching NEITHER the agent nor the record worker;
//   • ELIGIBLE branch — a real review-loop escalation (a convergence loop parked on `wait-answer`,
//     opted in via `autoResolveEscalations`) is claimed by `pr.escalation-steward-collect`, handed to
//     the external `senior:escalation-steward` agent (stubbed), whose `resolved` decision is finalised
//     by `pr.escalation-steward-record` through the canonical attributed door — completing the parked
//     `wait-answer` and writing a `resolved` `escalation_auto_resolutions` row.
//
// The falsifiable core: the agent stub CAPTURES its `claimedTasks` input (proving the
// `claimed`→`claimedTasks` ioMapping), the record worker only runs on the eligible branch (proving the
// gateway condition), and the parked escalation's completion + final record prove the
// `resolutions`→record hand-off. Network isolation mirrors the sibling convergence e2e (GitHub
// transport forced to `token` with no token, so best-effort GitHub reads short-circuit).
//
// Run with `npm run e2e` (a dedicated node:test invocation, kept out of the fast unit `npm test`).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";
import { ESCALATION_STEWARD_PROCESS_ID } from "../app/escalationSteward.ts";
import { pollUserTasks } from "../app/service.ts";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DB_DIR = mkdtempSync(join(tmpdir(), "nwf-steward-e2e-"));

const GITHUB_ENV_OVERRIDES: Record<string, string> = {
  NANO_PR_GITHUB_TRANSPORT: "token",
  GITHUB_TOKEN: "",
};
const savedEnv = new Map<string, string | undefined>();

const HARNESS_ENV = {
  NANO_APP_DB_URL: `file:${join(DB_DIR, "app.db")}`,
} as const;

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

/** Start one steward tick and settle it. `engine.createInstance` is the same door the production
 *  poller (`pollEscalationSteward`) uses; driving it directly keeps the tick deterministic (no
 *  dependence on the 30-min interval / the testkit's virtual clock). */
async function runStewardTick(app: TestApp): Promise<void> {
  await app.engine.createInstance({ processDefinitionId: ESCALATION_STEWARD_PROCESS_ID, variables: { minAgeMs: 0 } });
  await app.settle();
}

describe("escalation-steward orchestration (engine-level)", () => {
  let app: TestApp;
  // The steward agent stub's captured state across activations.
  let agentCalls = 0;
  let capturedClaimedTasks: unknown;

  before(async () => {
    for (const [k, v] of Object.entries(GITHUB_ENV_OVERRIDES)) {
      savedEnv.set(k, process.env[k]);
      process.env[k] = v;
    }
    app = await bootTestApp(APP_ROOT, { env: HARNESS_ENV });

    // `senior:pr-review` is an externalTaskType (no app worker): round 1 escalates (needs_input +
    // question) so the loop parks on the native `wait-answer` userTask; any resumed round converges.
    await app.engine.registerWorker("senior:pr-review", () => ({ status: "needs_input", summary: "need a human decision", question: "Which retry cap?" }));
    // `senior:scope-classify` is likewise external — stub "scope delivered" so a converged round
    // finalizes rather than parking on an unserviced agent job.
    await app.engine.registerWorker("senior:scope-classify", () => ({ scopeBlocked: false, scopeBlockReason: "" }));
    // The converge-gate fails closed without a live GitHub transport (sealed here); stub it clean so a
    // resumed round finalizes rather than parking on a second escalation.
    await app.engine.registerWorker("pr.converge-gate", () => ({ convergeBlocked: false, convergeBlockReason: "" }));

    // `senior:escalation-steward` is the external AGENT the steward process dispatches. Stub it to
    // capture its `claimedTasks` input (proving the `claimed`→`claimedTasks` ioMapping) and return a
    // `resolved` decision for each claimed task, so the record worker finalises it. The decision's
    // `variables` carry the escalation form's `answer` field (the `wait-answer`/`pr-escalation`
    // contract), and the rationale+evidence satisfy the record worker's evidence-before-choosing guard.
    await app.engine.registerWorker("senior:escalation-steward", (job) => {
      agentCalls += 1;
      const claimed = (job.variables as Record<string, unknown>).claimedTasks;
      capturedClaimedTasks = claimed;
      const keys = (Array.isArray(claimed) ? claimed : [])
        .map((entry) => {
          try {
            const row = JSON.parse(String(entry)) as { user_task_key?: string };
            return typeof row.user_task_key === "string" ? row.user_task_key : null;
          } catch {
            return null;
          }
        })
        .filter((k): k is string => k != null);
      return {
        resolutions: JSON.stringify(
          keys.map((userTaskKey) => ({
            userTaskKey,
            outcome: "resolved",
            variables: { answer: "Cap the retries at 5 and proceed." },
            rationale: "the retry cap is the safe, reversible choice",
            evidence: "git ls-remote showed no branch; the prior round made no progress",
          })),
        ),
      };
    });

    // `pr.escalation-steward-collect` / `pr.escalation-steward-record` are APP workers — the app
    // registers their real handlers on boot, so the eligible branch exercises the genuine record path
    // (the canonical attributed door + the durable `escalation_auto_resolutions` write). No stub needed;
    // the record worker having run is proven by its durable side effect (a `resolved` record) and the
    // `record->done` flow.
  });

  after(async () => {
    await app?.stop();
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(DB_DIR, { recursive: true, force: true });
  });

  test("no-eligible branch: a tick with no opted-in escalation takes the gateway default and dispatches nothing", async () => {
    const agentBefore = agentCalls;
    await runStewardTick(app);
    const flows = takenFlows(app);
    assert.ok(flows.includes("gw_any->done"), `the no-eligible tick took the gateway default (flows: ${flows.join(", ")})`);
    assert.ok(!flows.includes("gw_any->steward-agent"), "the agent was NOT dispatched on the no-eligible branch");
    assert.ok(!flows.includes("steward-agent->record"), "the record worker was NOT reached on the no-eligible branch");
    assert.equal(agentCalls, agentBefore, "the steward agent did not run");
  });

  test("eligible branch: a parked escalation is claimed, dispatched to the agent, and resolved by the record worker", async () => {
    const api = app.api;
    assert.ok(api, "the OpenAPI driver is available");

    // Opt this loop's escalations into the steward and drive a review round to park on `wait-answer`.
    const prKey = "acme/widgets#88";
    const started = await api.call<{ prKey: string }>("startConvergenceLoop", {
      body: { pr: prKey, convergeOnly: true, autoResolveEscalations: true },
    });
    assert.equal(started.status, 202, "start returns 202 Accepted");
    await app.settle();

    // Project the parked `wait-answer` escalation into the `user_tasks` read model the collect worker
    // scans (the projection is part of the imperative poll loop the testkit does not run).
    await pollUserTasks(app.db, app.engine);
    const openTasks = await app.db.table<{ user_task_key: string; element_id: string }>("user_tasks", "user_task_key").all();
    assert.ok(openTasks.some((t) => t.element_id === "wait-answer"), "the review-loop escalation is projected as an open user task");

    const agentBefore = agentCalls;
    await runStewardTick(app);

    // The gateway routed to the agent + record branch.
    const flows = takenFlows(app);
    assert.ok(flows.includes("gw_any->steward-agent"), `the eligible tick dispatched the agent (flows: ${flows.join(", ")})`);
    assert.ok(flows.includes("steward-agent->record") && flows.includes("record->done"), "the agent's resolutions reached the record worker and the tick completed");
    assert.equal(agentCalls, agentBefore + 1, "the steward agent ran once for the eligible tick");

    // The `claimed`→`claimedTasks` ioMapping carried the claimed escalation to the agent.
    const claimed = Array.isArray(capturedClaimedTasks) ? capturedClaimedTasks : [];
    assert.ok(claimed.length >= 1, "the agent received at least one claimed task");
    const claimedRows = claimed.map((e) => JSON.parse(String(e)) as { user_task_key?: string; element_id?: string });
    assert.ok(claimedRows.some((r) => r.element_id === "wait-answer"), "the claimed set includes the parked wait-answer escalation");

    // The record worker completed the parked escalation through the canonical door and wrote a
    // `resolved` record — the audit row is final.
    const records = await app.db
      .table<{ user_task_key: string; outcome: string; selected_option: string | null }>("escalation_auto_resolutions", "id")
      .all();
    assert.ok(
      records.some((r) => r.outcome === "resolved"),
      `a resolved auto-resolution record was written (records: ${JSON.stringify(records.map((r) => r.outcome))})`,
    );
    // Re-project the read model (as the durable poller would) so the completed task's row reconciles
    // away before asserting the escalation is no longer open.
    await pollUserTasks(app.db, app.engine);
    const stillOpen = await app.db.table<{ user_task_key: string; element_id: string }>("user_tasks", "user_task_key").all();
    assert.ok(!stillOpen.some((t) => t.element_id === "wait-answer"), "the steward's resolution completed the parked escalation");
  });
});
