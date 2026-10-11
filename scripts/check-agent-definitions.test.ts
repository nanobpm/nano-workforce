// Red/green coverage for the agent-definition repo-wide guard (scripts/check-agent-definitions.ts,
// issue #884). The gate fails the build when any `senior:*` agent service task — hand-authored in
// `resources/processes/*.bpmn` OR produced by the delivery-graph compiler — lacks the engine-native
// `<zeebe:agentDefinition agentType="external" />` marker (the omission that left every delivery-graph
// agent run without a durable transcript). These cases assert the scanner wiring flags an unmarked
// prompt-bearing task and that the gate's compiled-output half sees a real compiled agent cell.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "#test-assert";
import {
  agentTaskTypesMissingExternalMarker,
  externalAgentTaskTypesMissingMarker,
} from "../app/agentic/vocab/job-types.ts";
import { checkAuthoredProcesses, checkCompiledOutput } from "./check-agent-definitions.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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
  // Every compiled agent cell is prompt-LESS (Option (a)), so it is the type-keyed half of the union
  // scanner (keyed by the `<rank>:<task>` colon-form type) that sees them. The probe's agent types are
  // derived by that same grammar — assert the cells really compiled (the scan is not vacuously green).
  assert(r.agentTypes.length > 0, "the compiled probe declares senior:* agent cells");
  assert(r.agentTypes.includes("senior:feature"), "the compiled senior:feature cell is scanned");
});

test("check-agent-definitions: the compiled probe includes a prompt-LESS agent cell, and it is marked", async () => {
  // Every compiled agent cell is deliberately prompt-less (the resolved #884 "Decide", Option (a)), so
  // the prompt-keyed scanner never sees it — the gate must probe one and assert its marker with the
  // type-keyed scan, or a compiler regression that drops the marker on exactly those cells reports ok
  // (the false-negative path from the PR #886 review).
  const r = await checkCompiledOutput();
  assert(r.ok, `expected the compiled output to pass, got ${JSON.stringify(r.errors)}`);
  assert(
    r.agentTypes.includes("senior:bespoke-promptless"),
    `the compiled probe includes a prompt-less agent cell, got [${r.agentTypes.join(", ")}]`,
  );
});

test("check-agent-definitions: the type-keyed scanner flags a prompt-less compiled cell that lost its marker", () => {
  // Pin the false-negative shape the review cited: a prompt-less agent task with NO marker. The
  // prompt-keyed scan reports nothing (it cannot see the block); the type-keyed scan must flag it.
  const xml = `
    <bpmn:serviceTask id="n0_task">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:bespoke-promptless" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(agentTaskTypesMissingExternalMarker(xml), []);
  assertEquals(externalAgentTaskTypesMissingMarker(xml), ["senior:bespoke-promptless"]);
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
        <zeebe:taskDefinition type="senior:bespoke-promptless" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  const r = checkAuthoredProcesses([{ file: "bad.bpmn", xml: bad }]);
  assert(!r.ok, "a prompt-less + marker-less senior:* authored task must fail the gate");
  assert(
    r.errors.some((e) => e.includes("bad.bpmn") && e.includes("senior:bespoke-promptless")),
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

test("check-agent-definitions: AGENTS.md documents the check:agent-definitions CI gate", () => {
  // Advisory (PR #886 review): adding the `check:agent-definitions` CI command left the contributor
  // guide's "Runtime & CI gates" list stale — AGENTS.md tells contributors how to match CI locally
  // but did not name the new gate. Pin the doc so the gate cannot silently drop out of the guide.
  const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
  assert(
    agents.includes("check:agent-definitions"),
    "AGENTS.md must document the check:agent-definitions gate in its Runtime & CI gates list",
  );
});
