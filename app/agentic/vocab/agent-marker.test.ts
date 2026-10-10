// Tests for the engine-native AgentTask marker (issue #745, umbrella #746 — Camunda 8.10 parity),
// including the defect-class regression guard: every deployed prompt-bearing `senior:*` agent task
// must carry `<zeebe:agentDefinition agentType="external" />` alongside its `<zeebe:taskDefinition>`,
// so the worker harness mints an engine-native AgentInstance for it. A newly-added agent task that
// forgets the marker never persists durable AgentHistory — so it fails CI here instead of silently
// drifting.
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "#test-assert";
import { compileDeliveryGraph } from "../../deliveryGraphCompiler.ts";
import { agentTaskTypesMissingExternalMarker, promptBearingTaskTypes } from "./job-types.ts";

const PROCESSES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../resources/processes");

// urban deploys `resources/` recursively (every file at any depth), so a process
// model added under a subdirectory would still deploy — walk recursively here too,
// or the guard would miss it and let an unmarked agent task slip through.
function bpmnFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith(".bpmn") ? [relative(PROCESSES_DIR, full)] : [];
    });
  return walk(PROCESSES_DIR).sort();
}

test("agentTaskTypesMissingExternalMarker flags a prompt-bearing agent task with no external marker", () => {
  const xml = `
    <bpmn:serviceTask id="agent">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:feature" />
        <zeebe:linkedResources>
          <zeebe:linkedResource resourceId="feature.md" resourceType="GenericScript" linkName="prompt" />
        </zeebe:linkedResources>
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(agentTaskTypesMissingExternalMarker(xml), ["senior:feature"]);
});

test("agentTaskTypesMissingExternalMarker passes a marked agent task and ignores a plain host task", () => {
  const xml = `
    <bpmn:serviceTask id="host">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="pr.finalize" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:serviceTask id="agent">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:feature" />
        <zeebe:agentDefinition agentType="external" />
        <zeebe:linkedResources>
          <zeebe:linkedResource resourceId="feature.md" resourceType="GenericScript" linkName="prompt" />
        </zeebe:linkedResources>
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(agentTaskTypesMissingExternalMarker(xml), []);
});

test("DEFECT-CLASS GUARD: every deployed prompt-bearing agent task carries the external AgentTask marker", () => {
  let anyAgentTasks = false;
  for (const file of bpmnFiles()) {
    const xml = readFileSync(join(PROCESSES_DIR, file), "utf8");
    if (promptBearingTaskTypes(xml).length > 0) anyAgentTasks = true;
    const missing = agentTaskTypesMissingExternalMarker(xml);
    assert(
      missing.length === 0,
      `${file}: agent task(s) missing <zeebe:agentDefinition agentType="external" /> — ${missing.join(", ")}`,
    );
  }
  // Sanity: the models really do declare agent tasks (guard is not vacuously green).
  assert(anyAgentTasks, "the deployed models declare prompt-bearing agent tasks");
});

test("DEFECT-CLASS GUARD (compiler output, issue #884): every COMPILED delivery-graph agent cell carries the marker", async () => {
  // The hand-authored corpus above is only HALF the class — the delivery-graph COMPILER
  // (`app/deliveryGraphCompiler.ts`) is the other producer of agent service tasks, and it emitted
  // cells with NO `agentDefinition` (and no prompt link) until #884: every delivery-graph agent run
  // failed AgentInstance creation (`… has no agentDefinition`) and persisted no durable transcript
  // (269 failed creates on omarchy). The canonical scanner keys a task as an agent by its prompt
  // link, which a compiled cell now carries (the compiler links the job type's base prompt); apply
  // the SAME scanner to the compiler's OUTPUT so a compiler regression that drops the marker (or the
  // link that makes the cell visible to the scanner) fails here — not silently at runtime.
  const r = await compileDeliveryGraph({
    nodes: [
      { id: "impl", kind: "agent", agent: { jobType: "senior:feature", prompt: "implement #1" }, emits: [{ name: "pr", type: "pr" }] },
      { id: "review", kind: "agent", agent: { jobType: "senior:pr-review" } },
    ],
    edges: [{ from: "impl", to: "review" }],
  });
  assert(r.ok, `expected the graph to compile, got ${JSON.stringify(r)}`);
  // The compiled agent cells ARE prompt-bearing now (the linked base prompt), so the scanner sees them.
  assert(promptBearingTaskTypes(r.bpmn).length > 0, "the compiled agent cells are prompt-bearing (the scanner sees them)");
  const missing = agentTaskTypesMissingExternalMarker(r.bpmn);
  assert(
    missing.length === 0,
    `compiled delivery-graph agent cell(s) missing <zeebe:agentDefinition agentType="external" /> — ${missing.join(", ")}`,
  );
});
