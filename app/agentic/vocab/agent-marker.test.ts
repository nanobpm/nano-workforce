// Tests for the engine-native AgentTask marker (issue #745, umbrella #746 — Camunda 8.10 parity),
// including the defect-class regression guard: every deployed prompt-bearing `senior:*` agent task
// must carry `<zeebe:agentDefinition agentType="external"/>` alongside its `<zeebe:taskDefinition>`,
// so the worker harness mints an engine-native AgentInstance for it. A newly-added agent task that
// forgets the marker never persists durable AgentHistory — so it fails CI here instead of silently
// drifting.
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "#test-assert";
import { agentTaskTypesMissingExternalMarker, promptBearingTaskTypes } from "./job-types.ts";

const PROCESSES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../resources/processes");

function bpmnFiles(): string[] {
  return readdirSync(PROCESSES_DIR)
    .filter((f) => f.endsWith(".bpmn"))
    .sort();
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
      `${file}: agent task(s) missing <zeebe:agentDefinition agentType="external"> — ${missing.join(", ")}`,
    );
  }
  // Sanity: the models really do declare agent tasks (guard is not vacuously green).
  assert(anyAgentTasks, "the deployed models declare prompt-bearing agent tasks");
});
