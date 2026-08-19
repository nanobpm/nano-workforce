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
import { jobTypeToRoutingToken, promptBearingTaskTypes } from "./job-types.ts";

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
