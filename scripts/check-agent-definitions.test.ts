// Red/green coverage for the agent-definition repo-wide guard (scripts/check-agent-definitions.ts,
// issue #884). The gate fails the build when any `senior:*` agent service task — hand-authored in
// `resources/processes/*.bpmn` OR produced by the delivery-graph compiler — lacks the engine-native
// `<zeebe:agentDefinition agentType="external" />` marker (the omission that left every delivery-graph
// agent run without a durable transcript). These cases assert the scanner wiring flags an unmarked
// prompt-bearing task and that the gate's compiled-output half sees a real compiled agent cell.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { agentTaskTypesMissingExternalMarker } from "../app/agentic/vocab/job-types.ts";
import { checkAuthoredProcesses, checkCompiledOutput } from "./check-agent-definitions.ts";

test("check-agent-definitions: the canonical scanner flags an unmarked prompt-bearing senior:* task", () => {
  // The gate's red path rests entirely on the canonical scanner — pin that wiring here so the gate
  // can never rot into a vacuous green (a scanner that stopped flagging would pass every corpus).
  const xml = `
    <bpmn:serviceTask id="agent">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:feature" />
        <zeebe:linkedResources>
          <zeebe:linkedResource resourceId="prompts/feature.md" bindingType="latest" resourceType="GenericScript" linkName="prompt" />
        </zeebe:linkedResources>
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(agentTaskTypesMissingExternalMarker(xml), ["senior:feature"]);
});

test("check-agent-definitions: the hand-authored corpus passes (every senior:* task is marked)", () => {
  const r = checkAuthoredProcesses();
  assert(r.ok, `expected the authored corpus to pass, got ${JSON.stringify(r.errors)}`);
  // Sanity: the corpus really does declare agent tasks (the guard is not vacuously green).
  assert(r.agentTypes.length > 0, "the authored corpus declares prompt-bearing senior:* agent tasks");
  assert(r.agentTypes.includes("senior:feature"), "senior:feature is among the scanned agent types");
});

test("check-agent-definitions: the compiled-output half sees a real compiled agent cell and finds it marked", async () => {
  const r = await checkCompiledOutput();
  assert(r.ok, `expected the compiled output to pass, got ${JSON.stringify(r.errors)}`);
  // The compiled agent cells must be prompt-bearing (the linked base prompt) — that is what makes
  // them VISIBLE to the marker scanner. If a compiler regression dropped the link, this assertion
  // fails (the scan would otherwise pass vacuously over invisible cells).
  assert(r.agentTypes.length > 0, "the compiled agent cells are prompt-bearing (visible to the scanner)");
  assert(r.agentTypes.includes("senior:feature"), "the compiled senior:feature cell is scanned");
});
