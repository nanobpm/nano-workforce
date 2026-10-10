// Tests for the deployed-job-type ↔ crew-routing-token bridge (issue #323), including the
// defect-class regression guard: every deployed prompt-bearing agent job type must resolve to a
// SERVE token a representative enrolled senior worker can supply, so a newly-added agent task that is
// not wired into the crew vocab fails CI instead of silently showing RED on the demand×supply board.
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "#test-assert";
import type { Capability } from "@nanobpm/agentic/protocol";
import { crewResolver } from "./crew-vocab.ts";
import { externalAgentTaskTypesMissingMarker, jobTypeToRoutingToken, missingExternalMarkerAgentTaskTypes, promptBearingTaskTypes, promptLinkByTaskType } from "./job-types.ts";

const PROCESSES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../resources/processes");

/** Every prompt-bearing agent job type deployed across the BPMN models, distinct and sorted. */
function deployedAgentJobTypes(): string[] {
  const types = new Set<string>();
  for (const file of readdirSync(PROCESSES_DIR)) {
    if (!file.endsWith(".bpmn")) continue;
    for (const type of promptBearingTaskTypes(readFileSync(join(PROCESSES_DIR, file), "utf8"))) {
      types.add(type);
    }
  }
  return [...types].sort();
}

// A representative enrolled senior worker — the staffing the board assumes when it reports supply.
const seniorWorker: Capability = { cognition: "implementation", weight: 5, family: "frontier", host: "h1" };

test("jobTypeToRoutingToken derives the bare rank token from a colon-form agent job type", () => {
  assertEquals(jobTypeToRoutingToken("senior:feature"), "senior");
  assertEquals(jobTypeToRoutingToken("senior:retro"), "senior");
  assertEquals(jobTypeToRoutingToken("senior:plan-review"), "senior");
  assertEquals(jobTypeToRoutingToken("senior:trial-merge"), "senior");
});

test("jobTypeToRoutingToken returns undefined for a non-agent (dot-form host) job type", () => {
  assertEquals(jobTypeToRoutingToken("pr.finalize"), undefined);
  assertEquals(jobTypeToRoutingToken("pr.record-plan"), undefined);
});

test("jobTypeToRoutingToken returns undefined for malformed / non-routing rank forms", () => {
  assertEquals(jobTypeToRoutingToken(":feature"), undefined); // empty rank
  assertEquals(jobTypeToRoutingToken("senior:"), undefined); // empty task
  assertEquals(jobTypeToRoutingToken("senior"), undefined); // no colon at all
  assertEquals(jobTypeToRoutingToken("Senior:feature"), undefined); // not a valid segment
});

test("jobTypeToRoutingToken rejects a dotted (multi-segment) rank prefix", () => {
  // A dotted prefix is a multi-segment routing token, not a bare rank role — bridging it would
  // distort demand/supply matching, so it must not derive.
  assertEquals(jobTypeToRoutingToken("implementation.senior:feature"), undefined);
  assertEquals(jobTypeToRoutingToken("planning.spar:plan"), undefined);
});

test("jobTypeToRoutingToken rejects a multi-colon job type (not `<rank>:<task>` form)", () => {
  assertEquals(jobTypeToRoutingToken("senior:feature:extra"), undefined);
});

test("promptBearingTaskTypes picks a prompt-linked agent task and skips a plain host task", () => {
  const xml = `
    <bpmn:serviceTask id="host">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="pr.finalize" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:serviceTask id="agent">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:feature" />
        <zeebe:linkedResources>
          <zeebe:linkedResource resourceId="feature.md" resourceType="GenericScript" linkName="prompt" />
        </zeebe:linkedResources>
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(promptBearingTaskTypes(xml), ["senior:feature"]);
});

test("a representative senior worker serves the bare `senior` routing role", () => {
  assert(crewResolver().resolve(seniorWorker).tokens.includes("senior"), "senior worker serves `senior`");
});

test("retro and rebase specifically resolve to a supplying role", () => {
  for (const jobType of ["senior:retro", "senior:rebase"]) {
    const token = jobTypeToRoutingToken(jobType);
    assert(token !== undefined, `${jobType} derives a routing token`);
    assert(
      crewResolver().resolve(seniorWorker).tokens.includes(token),
      `${jobType} → ${token} is supplied by a senior worker`,
    );
  }
});

test("DEFECT-CLASS GUARD: every deployed prompt-bearing agent job type resolves to a suppliable SERVE token", () => {
  const jobTypes = deployedAgentJobTypes();
  // Sanity: the models really do declare agent tasks (guard is not vacuously green).
  assert(jobTypes.length > 0, "the deployed models declare prompt-bearing agent tasks");
  const serve = new Set(crewResolver().resolve(seniorWorker).tokens);
  for (const jobType of jobTypes) {
    const token = jobTypeToRoutingToken(jobType);
    assert(token !== undefined, `deployed agent job type ${jobType} is not in <rank>:<task> form`);
    assert(
      serve.has(token),
      `deployed agent job type ${jobType} resolves to ${token}, which no enrolled senior worker supplies — wire it into the crew vocab`,
    );
  }
});

test("externalAgentTaskTypesMissingMarker flags an UNMAPPED (prompt-less) agent task with no marker", () => {
  // The prompt-keyed scanner (`agentTaskTypesMissingExternalMarker`) cannot see this block — it has no
  // prompt link. The marker scan must key on the colon-form job type ALONE (issue #886 review): a
  // compiled delivery-graph cell for a bespoke `senior:<task>` (no deployed base prompt, deliberately
  // prompt-less) must still carry the marker or it runs transcript-less.
  const xml = `
    <bpmn:serviceTask id="agent">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:bespoke" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(externalAgentTaskTypesMissingMarker(xml), ["senior:bespoke"]);
});

test("externalAgentTaskTypesMissingMarker passes a marked prompt-less agent task and ignores a plain host task", () => {
  const xml = `
    <bpmn:serviceTask id="host">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="pr.finalize" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:serviceTask id="agent">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:bespoke" />
        <zeebe:agentDefinition agentType="external" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(externalAgentTaskTypesMissingMarker(xml), []);
});

test("externalAgentTaskTypesMissingMarker flags a marked-outside-extensionElements task (placement contract)", () => {
  // A marker sitting OUTSIDE `<bpmn:extensionElements>` is ignored by the engine, so it must not
  // "cover" the task here either (the same placement scope the prompt-keyed scanner enforces).
  const xml = `
    <bpmn:serviceTask id="agent">
      <zeebe:agentDefinition agentType="external" />
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:bespoke" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(externalAgentTaskTypesMissingMarker(xml), ["senior:bespoke"]);
});

test("externalAgentTaskTypesMissingMarker ignores malformed/non-agent types (no false positives)", () => {
  // Only a `<rank>:<task>` colon-form type (the `jobTypeToRoutingToken` grammar) keys a block as an
  // agent task: a dot-form host job, a typeless block, and a malformed colon form are all out of
  // scope — the scanner must not flag them as unmarked agents.
  const xml = `
    <bpmn:serviceTask id="host1">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="pr.finalize" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:serviceTask id="host2">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:feature:extra" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:serviceTask id="host3">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:serviceTask id="host4">
      <bpmn:extensionElements>
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(externalAgentTaskTypesMissingMarker(xml), []);
});

test("missingExternalMarkerAgentTaskTypes unions BOTH scanners — catches a prompt-bearing AND a prompt-less unmarked agent task", () => {
  // The single "every agent task carries the external marker" invariant (PR #886 review): a
  // prompt-BEARING senior:* task that loses its marker is caught only by the prompt-keyed scanner,
  // while a prompt-LESS senior:* task that loses its marker is caught only by the type-keyed scanner.
  // Scanning by just one leaves the other's blind spot open, so the union must flag BOTH in one pass.
  const xml = `
    <bpmn:serviceTask id="prompted">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:feature" />
        <zeebe:linkedResources>
          <zeebe:linkedResource resourceId="prompts/feature.md" linkName="prompt" />
        </zeebe:linkedResources>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:serviceTask id="bespoke">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:bespoke" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(missingExternalMarkerAgentTaskTypes(xml), ["senior:feature", "senior:bespoke"]);
});

test("missingExternalMarkerAgentTaskTypes passes when every agent task is marked and ignores host tasks", () => {
  const xml = `
    <bpmn:serviceTask id="host">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="pr.finalize" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:serviceTask id="prompted">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:feature" />
        <zeebe:agentDefinition agentType="external" />
        <zeebe:linkedResources>
          <zeebe:linkedResource resourceId="prompts/feature.md" linkName="prompt" />
        </zeebe:linkedResources>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:serviceTask id="bespoke">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:bespoke" />
        <zeebe:agentDefinition agentType="external" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(missingExternalMarkerAgentTaskTypes(xml), []);
});

test("missingExternalMarkerAgentTaskTypes de-duplicates a type caught by both scanners", () => {
  // A prompt-bearing task missing its marker is seen by BOTH the prompt-keyed and the type-keyed
  // scanner; the union must report it ONCE, not twice.
  const xml = `
    <bpmn:serviceTask id="prompted">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:feature" />
        <zeebe:linkedResources>
          <zeebe:linkedResource resourceId="prompts/feature.md" linkName="prompt" />
        </zeebe:linkedResources>
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(missingExternalMarkerAgentTaskTypes(xml), ["senior:feature"]);
});

test("promptLinkByTaskType maps each prompt-bearing agent task to its linked prompt resource", () => {
  const xml = `
    <bpmn:serviceTask id="a">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:feature" />
        <zeebe:linkedResources>
          <zeebe:linkedResource resourceId="prompts/feature.md" linkName="prompt" />
        </zeebe:linkedResources>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:serviceTask id="b">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:pr-review" />
        <zeebe:linkedResources>
          <zeebe:linkedResource resourceId="prompts/review-round.md" linkName="prompt" />
        </zeebe:linkedResources>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:serviceTask id="host">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="pr.finalize" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(promptLinkByTaskType(xml), {
    "senior:feature": "prompts/feature.md",
    "senior:pr-review": "prompts/review-round.md",
  });
});

test("promptLinkByTaskType ignores a prompt-less agent task and a non-prompt link", () => {
  // A prompt-less agent cell (no linkedResource) contributes NO entry — the registry comparison only
  // covers job types the corpus actually links a prompt for. A linkedResource with a different
  // linkName is not the base-prompt link.
  const xml = `
    <bpmn:serviceTask id="unmapped">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:bespoke-unmapped" />
        <zeebe:agentDefinition agentType="external" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:serviceTask id="otherlink">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:plan" />
        <zeebe:linkedResources>
          <zeebe:linkedResource resourceId="prompts/plan.md" linkName="schema" />
        </zeebe:linkedResources>
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(promptLinkByTaskType(xml), {});
});
