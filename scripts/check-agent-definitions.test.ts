// Red/green coverage for the agent-definition repo-wide guard (scripts/check-agent-definitions.ts,
// issue #884). The gate fails the build when any `senior:*` agent service task — hand-authored in
// `resources/processes/*.bpmn` OR produced by the delivery-graph compiler — lacks the engine-native
// `<zeebe:agentDefinition agentType="external" />` marker (the omission that left every delivery-graph
// agent run without a durable transcript). These cases assert the scanner wiring flags an unmarked
// prompt-bearing task and that the gate's compiled-output half sees a real compiled agent cell.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import {
  agentTaskTypesMissingExternalMarker,
  externalAgentTaskTypesMissingMarker,
} from "../app/agentic/vocab/job-types.ts";
import { AGENT_JOB_TYPE_PROMPT } from "../app/deliveryGraphCompiler.ts";
import { checkAuthoredProcesses, checkCompiledOutput, checkJobTypePromptMappings } from "./check-agent-definitions.ts";

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

test("check-agent-definitions: the compiled probe includes an UNMAPPED (prompt-less) agent cell, and it is marked", async () => {
  // A compiled cell for a bespoke `senior:<task>` with no deployed base prompt is DELIBERATELY
  // prompt-less, so the prompt-keyed scanner never sees it — the gate must probe one and assert its
  // marker with the type-keyed scan, or a compiler regression that drops the marker on exactly those
  // cells reports ok (the false-negative path from the PR #886 review).
  const r = await checkCompiledOutput();
  assert(r.ok, `expected the compiled output to pass, got ${JSON.stringify(r.errors)}`);
  assert(
    r.agentTypes.includes("senior:bespoke-unmapped"),
    `the compiled probe includes an unmapped (prompt-less) agent cell, got [${r.agentTypes.join(", ")}]`,
  );
});

test("check-agent-definitions: the type-keyed scanner flags a prompt-less compiled cell that lost its marker", () => {
  // Pin the false-negative shape the review cited: a prompt-less agent task with NO marker. The
  // prompt-keyed scan reports nothing (it cannot see the block); the type-keyed scan must flag it.
  const xml = `
    <bpmn:serviceTask id="n0_task">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:bespoke-unmapped" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(agentTaskTypesMissingExternalMarker(xml), []);
  assertEquals(externalAgentTaskTypesMissingMarker(xml), ["senior:bespoke-unmapped"]);
});

test("check-agent-definitions: every AGENT_JOB_TYPE_PROMPT entry resolves to a deployed prompt resource", () => {
  // The compiler's job-type→prompt registry duplicates the relationship the hand-authored BPMN corpus
  // authors per task, but `check:prompts` scans only the corpus's XML links — a registry entry can
  // drift to an undeployed/typo'd resourceId and CI stays green while the engine silently omits the
  // link (the agent runs prompt-less). The gate iterates EVERY mapping and resolves it against the
  // deployed `resources/` set, so no entry drifts undetected (PR #886 review).
  const r = checkJobTypePromptMappings();
  assert(r.ok, `expected every job-type→prompt mapping to resolve, got ${JSON.stringify(r.errors)}`);
  // Sanity: the registry really is populated (the guard is not vacuously green) and covers the
  // hand-authored corpus's agent job types.
  const mapped = Object.keys(AGENT_JOB_TYPE_PROMPT);
  assert(mapped.length > 0, "AGENT_JOB_TYPE_PROMPT is populated");
  for (const t of ["senior:feature", "senior:pr-review", "senior:plan", "senior:retro"]) {
    assert(mapped.includes(t), `${t} has a job-type→prompt mapping`);
  }
});

test("check-agent-definitions: a mapping to an undeployed prompt resource fails", () => {
  const r = checkJobTypePromptMappings({ "senior:bogus": "prompts/does-not-exist.md" });
  assert(!r.ok, "a mapping to an undeployed resourceId must fail the gate");
  assert(
    r.errors.some((e) => e.includes("senior:bogus") && e.includes("prompts/does-not-exist.md")),
    `the error names the drifting mapping, got ${JSON.stringify(r.errors)}`,
  );
});

test("check-agent-definitions: the authored half unions BOTH scanners — a prompt-less + marker-less senior:* task fails", () => {
  // The authored-process half must hold the SAME "every senior:* task carries the marker" invariant
  // the compiled half does (PR #886 review). A hand-authored senior:* task that loses BOTH its prompt
  // link and its marker is invisible to the prompt-keyed scanner, so a prompt-keyed-only authored gate
  // reports ok — the false-negative the compiled half already closes. Inject a doc with exactly that
  // shape and assert the gate flags it (via the type-keyed half of the union).
  const bad = `
    <bpmn:serviceTask id="agent">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:bespoke-unmapped" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  const r = checkAuthoredProcesses([{ file: "bad.bpmn", xml: bad }]);
  assert(!r.ok, "a prompt-less + marker-less senior:* authored task must fail the gate");
  assert(
    r.errors.some((e) => e.includes("bad.bpmn") && e.includes("senior:bespoke-unmapped")),
    `the error names the unmarked prompt-less task, got ${JSON.stringify(r.errors)}`,
  );
});

test("check-agent-definitions: the authored half still flags a prompt-BEARING task that lost its marker", () => {
  const bad = `
    <bpmn:serviceTask id="agent">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:feature" />
        <zeebe:linkedResources>
          <zeebe:linkedResource resourceId="prompts/feature.md" linkName="prompt" />
        </zeebe:linkedResources>
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  const r = checkAuthoredProcesses([{ file: "bad.bpmn", xml: bad }]);
  assert(!r.ok, "a prompt-bearing senior:* authored task without a marker must fail the gate");
  assert(
    r.errors.some((e) => e.includes("bad.bpmn") && e.includes("senior:feature")),
    `the error names the unmarked prompt-bearing task, got ${JSON.stringify(r.errors)}`,
  );
});
