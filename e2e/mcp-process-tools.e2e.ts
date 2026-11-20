// MCP process tools — message start events on the user-facing entry processes (issue #976).
//
// The engine's process MCP (`/mcp/processes`) exposes one tool per message start event carrying
// `io.camunda.tool:*` (nano-bpm#1499), deriving the tool's `inputSchema` from the start message's
// data envelope (nano-bpm#1738). This suite pins the nwf side of that contract end to end against
// the WASM testkit engine:
//
//   1. Each entry process (`convergence-loop`, `feature`, `plan-fanout`) declares a message start
//      event with the tool markers and a start-message data envelope (a model-level assertion, so a
//      regression that drops the marker fails even without the MCP server in the loop).
//   2. A message-started run is EQUIVALENT to an API-started one: publishing the start message with
//      the tool's arguments runs the SAME canonical registration/seeding path as the API door — the
//      read-model row appears and the real run instance is dispatched with the same seeded
//      variables (asserted via the parked agent job's variables).
//   3. A duplicate submission is idempotent — like an `alreadyRunning` API re-POST, it does not
//      start a second run.
//   4. Invalid input fails LOUDLY (a job incident), never a silent blank-variable run.
//
// Run with `npm run e2e`.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { before, after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";
import { admitGithubState, installAdmitGithub } from "./support/github-admit.ts";
import { settleFully } from "./support/time.ts";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const GITHUB_ENV_OVERRIDES: Record<string, string> = {
  NANO_PR_GITHUB_TRANSPORT: "token",
  GITHUB_TOKEN: "",
};

// ── Model-level contract (no engine needed) ─────────────────────────────────────────────────────

interface ToolStartSpec {
  readonly file: string;
  readonly processId: string;
  readonly toolName: string;
  readonly messageName: string;
  readonly envelopeShape: string;
  /** Fields the tool's input schema must expose (the start message's envelope shape). */
  readonly requiredFields: readonly string[];
}

const TOOL_STARTS: readonly ToolStartSpec[] = [
  {
    file: "convergence-loop.bpmn",
    processId: "convergence-loop",
    toolName: "start_convergence_loop",
    messageName: "start-convergence-loop",
    envelopeShape: "ConvergenceToolIn",
    requiredFields: ["pr"],
  },
  {
    file: "feature.bpmn",
    processId: "feature",
    toolName: "start_feature",
    messageName: "start-feature",
    envelopeShape: "FeatureToolIn",
    requiredFields: ["issue", "baseBranch"],
  },
  {
    file: "plan-fanout.bpmn",
    processId: "plan-fanout",
    toolName: "start_plan_fanout",
    messageName: "start-plan-fanout",
    envelopeShape: "PlanToolIn",
    requiredFields: ["issue", "baseBranch"],
  },
];

/** The semantic process block of a model file (DI stripped). */
function processBlock(file: string): string {
  const xml = readFileSync(join(APP_ROOT, "resources", "processes", file), "utf8");
  const m = /<bpmn:process\b[^>]*>([\s\S]*?)<\/bpmn:process>/.exec(xml);
  assert(m !== null, `${file}: must contain a <bpmn:process>`);
  return m[0] ?? "";
}

/** The `<nano:shape id="…">` block of a process, or null. */
function shapeBlock(processXml: string, shapeId: string): string | null {
  const m = new RegExp(`<nano:shape\\b[^>]*\\bid="${shapeId}"[^>]*>([\\s\\S]*?)</nano:shape>`).exec(processXml);
  return m === null ? null : (m[0] ?? "");
}

describe("MCP process tools — model contract (issue #976)", () => {
  for (const spec of TOOL_STARTS) {
    test(`${spec.processId}: declares a tool message start event (${spec.toolName})`, () => {
      const block = processBlock(spec.file);
      // The start message exists at the definitions level and carries the data envelope the engine
      // derives the tool's inputSchema from (nano-bpm#1738).
      const xml = readFileSync(join(APP_ROOT, "resources", "processes", spec.file), "utf8");
      const msgRe = new RegExp(
        `<bpmn:message\\b[^>]*\\bname="${spec.messageName}"[^>]*>([\\s\\S]*?)</bpmn:message>`,
      );
      const msg = msgRe.exec(xml);
      assert(msg !== null, `${spec.file}: a <bpmn:message name="${spec.messageName}"> must exist`);
      assert.match(
        msg[1] ?? "",
        new RegExp(`<zeebe:property\\s+name="io\\.nanobpm\\.dataEnvelope\\.in"\\s+value="${spec.envelopeShape}"\\s*/>`),
        `${spec.file}: the ${spec.messageName} message must declare io.nanobpm.dataEnvelope.in=${spec.envelopeShape}`,
      );
      // A message START event references it and carries the Camunda tool markers.
      const startRe = /<bpmn:startEvent\b[^>]*>([\s\S]*?)<\/bpmn:startEvent>/g;
      const starts = [...block.matchAll(startRe)].map((m) => m[0]);
      const toolStart = starts.find(
        (s) =>
          s.includes(`messageRef="Message_${spec.messageName.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}"`) ||
          (s.includes("<bpmn:messageEventDefinition") && s.includes("io.camunda.tool:name")),
      );
      assert(toolStart !== undefined, `${spec.file}: a message start event must reference the ${spec.messageName} message`);
      for (const prop of ["name", "purpose", "inputs", "when_to_use", "when_not_to_use", "results"]) {
        assert.ok(
          toolStart.includes(`io.camunda.tool:${prop}`),
          `${spec.file}: the tool start event must carry io.camunda.tool:${prop}`,
        );
      }
      assert.ok(
        toolStart.includes(`<zeebe:property name="io.camunda.tool:name" value="${spec.toolName}"`),
        `${spec.file}: the tool name must be ${spec.toolName}`,
      );
      // The envelope shape carries the door's inputs (required fields present).
      const shape = shapeBlock(block, spec.envelopeShape);
      assert(shape !== null, `${spec.file}: the ${spec.envelopeShape} shape must exist`);
      for (const field of spec.requiredFields) {
        assert.ok(
          new RegExp(`<nano:extend\\b[^>]*\\bname="${field}"`).test(shape),
          `${spec.file}: ${spec.envelopeShape} must declare the required field "${field}"`,
        );
      }
    });
  }
});

// ── Runtime equivalence: a message-started run IS an API-started run ───────────────────────────

describe("MCP process tools — message-started runs (issue #976)", () => {
  const savedEnv = new Map<string, string | undefined>();
  let restoreGithub: (() => void) | undefined;
  const githubState = admitGithubState("owner/repo", "main");

  before(() => {
    for (const [k, v] of Object.entries(GITHUB_ENV_OVERRIDES)) {
      savedEnv.set(k, process.env[k]);
      process.env[k] = v;
    }
    restoreGithub = installAdmitGithub(githubState);
  });

  after(() => {
    restoreGithub?.();
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function withApp(body: (app: TestApp) => Promise<void>): Promise<void> {
    const dbDir = mkdtempSync(join(tmpdir(), "nwf-mcp-tools-"));
    const app = await bootTestApp(APP_ROOT, {
      env: { NANO_APP_DB_URL: `file:${join(dbDir, "app.db")}` },
    });
    try {
      await body(app);
    } finally {
      await app.stop();
      rmSync(dbDir, { recursive: true, force: true });
    }
  }

  test("feature: a start-feature message registers and dispatches the run exactly like startFeature", async () => {
    await withApp(async (app) => {
      await app.engine.publishMessage({
        name: "start-feature",
        correlationKey: "mcp-feature-1",
        variables: { issue: "owner/repo#1", baseBranch: "main", confirmDefaultBase: true },
      });
      await settleFully(app);
      // The canonical seeding path ran: the read-model row exists and names the dispatched instance.
      const run = await app.db
        .table<{ feature_key: string; status: string; process_key: string | null }>("feature_runs", "feature_key")
        .findOne({ feature_key: "owner/repo#1" });
      assert.ok(run, "the feature_runs row was registered");
      assert.equal(run.status, "running");
      assert.ok(run.process_key, "the row carries the dispatched instance key");
      // The real run instance was dispatched on the NONE start path (the MCP starter instance is
      // separate and terminates once it has admitted the run).
      const instances = await app.engine.searchProcessInstances({ processDefinitionId: "feature" });
      const active = instances.filter((i) => String(i.state) === "ACTIVE");
      assert.equal(active.length, 1, "exactly one live feature instance");
      // The seeded run parked at the implement cell's agent task (in the called `implement-cell`
      // child instance). Search engine-wide — the agent job lives on the child instance, not the
      // feature root.
      const jobs = await app.engine.searchJobs({});
      const implementJob = jobs.find((j) => j.elementId === "implement-task");
      assert.ok(implementJob, "the run parked at the implement cell's agent task");
      // The canonical start variables were seeded on the run's root instance (the API-started
      // equivalent): read them off the engine's variable index (a JobSummary carries no variables).
      const seeded = await app.engine.searchVariables({ processInstanceKey: run.process_key ?? "" });
      const byName = new Map(seeded.map((v) => [v.name, v.value]));
      assert.equal(byName.get("featureKey"), JSON.stringify("owner/repo#1"));
      assert.equal(byName.get("baseBranch"), JSON.stringify("main"));
      assert.equal(byName.get("claimIssue"), JSON.stringify(true), "a single-issue run claims its issue");
      const transcriptBase = byName.get("transcriptUrlBase");
      assert.ok(
        typeof transcriptBase === "string" && JSON.parse(transcriptBase) !== "",
        "transcriptUrlBase seeded",
      );
    });
  });

  test("feature: a duplicate start-feature message is idempotent (no second run)", async () => {
    await withApp(async (app) => {
      const vars = { issue: "owner/repo#2", baseBranch: "main", confirmDefaultBase: true };
      await app.engine.publishMessage({ name: "start-feature", correlationKey: "mcp-feature-2a", variables: vars });
      await settleFully(app);
      await app.engine.publishMessage({ name: "start-feature", correlationKey: "mcp-feature-2b", variables: vars });
      await settleFully(app);
      const instances = await app.engine.searchProcessInstances({ processDefinitionId: "feature" });
      const active = instances.filter((i) => String(i.state) === "ACTIVE");
      assert.equal(active.length, 1, "a duplicate submission does not start a second run");
      const runs = await app.db
        .table<{ feature_key: string }>("feature_runs", "feature_key")
        .find({ feature_key: "owner/repo#2" });
      assert.equal(runs.length, 1, "still exactly one feature_runs row");
    });
  });

  test("feature: invalid input fails loudly (incident), never a silent run", async () => {
    await withApp(async (app) => {
      await app.engine.publishMessage({
        name: "start-feature",
        correlationKey: "mcp-feature-bad",
        variables: { issue: "not-an-issue-ref", baseBranch: "main", confirmDefaultBase: true },
      });
      await settleFully(app);
      const incidents = await app.engine.searchIncidents({});
      assert.ok(incidents.length > 0, "an invalid start message raises an incident");
      const runs = await app.db
        .table<{ feature_key: string }>("feature_runs", "feature_key")
        .all();
      assert.equal(runs.length, 0, "no feature run was registered for invalid input");
    });
  });

  test("plan-fanout: a start-plan-fanout message registers and dispatches the epic like startPlan", async () => {
    await withApp(async (app) => {
      // Stub the planner + reviewer so the epic advances past planning.
      await app.engine.registerWorker("senior:plan", async () => ({ tasks: [] }));
      await app.engine.publishMessage({
        name: "start-plan-fanout",
        correlationKey: "mcp-plan-1",
        variables: { issue: "owner/repo#3", baseBranch: "epic/e2e-mcp" },
      });
      await settleFully(app);
      const plan = await app.db
        .table<{ plan_key: string; status: string; process_key: string | null }>("plans", "plan_key")
        .findOne({ plan_key: "owner/repo#3" });
      assert.ok(plan, "the plans row was registered");
      assert.ok(plan.process_key, "the plan row carries the dispatched instance key");
      const instances = await app.engine.searchProcessInstances({ processDefinitionId: "plan-fanout" });
      const active = instances.filter((i) => String(i.state) === "ACTIVE");
      assert.equal(active.length, 1, "exactly one live plan-fanout instance");
    });
  });

  test("convergence-loop: a start-convergence-loop message registers and dispatches the loop like submitPr", async () => {
    await withApp(async (app) => {
      await app.engine.publishMessage({
        name: "start-convergence-loop",
        correlationKey: "mcp-pr-1",
        variables: { pr: "owner/repo#7" },
      });
      await settleFully(app);
      const pr = await app.db
        .table<{ pr_key: string; status: string; process_key: string | null }>("pull_requests", "pr_key")
        .findOne({ pr_key: "owner/repo#7" });
      assert.ok(pr, "the pull_requests row was registered");
      assert.ok(pr.process_key, "the PR row carries the dispatched instance key");
      const instances = await app.engine.searchProcessInstances({ processDefinitionId: "convergence-loop" });
      const active = instances.filter((i) => String(i.state) === "ACTIVE");
      assert.equal(active.length, 1, "exactly one live convergence-loop instance");
    });
  });
});
