// Tests for the `--auto` opt-OUT marker (issue #779, harness jwulf/c8ctl-plugin-nano#235). The single
// agentic-task signal the harness `--auto` reconciliation scans is `<zeebe:agentDefinition
// agentType="external" />`; this marker — `<zeebe:property name="io.nanobpm.agentTask.autoSubscribe"
// value="false" />` inside an agent task's extensionElements — is the explicit escape hatch that
// EXCLUDES a task from `--auto` so it is served only by a worker that explicitly subscribes. Mirrors
// agent-marker.test.ts: assert the marker's shape/placement, and guard that any opted-out task in the
// deployed models is itself a real (externally-marked) agent task, so the opt-out can't drift onto a
// non-agent element.
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "#test-assert";
import {
  agentTaskTypesMissingExternalMarker,
  agentTaskTypesOptedOutOfAuto,
} from "./job-types.ts";

const PROCESSES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../resources/processes");

// urban deploys `resources/` recursively (every file at any depth), so an opted-out task added under
// a subdirectory would still deploy — walk recursively here too, or the guard would miss it.
function bpmnFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith(".bpmn") ? [relative(PROCESSES_DIR, full)] : [];
    });
  return walk(PROCESSES_DIR).sort();
}

test("agentTaskTypesOptedOutOfAuto flags a task carrying the value=\"false\" opt-out property", () => {
  const xml = `
    <bpmn:serviceTask id="agent">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:special" />
        <zeebe:agentDefinition agentType="external" />
        <zeebe:properties>
          <zeebe:property name="io.nanobpm.agentTask.autoSubscribe" value="false" />
        </zeebe:properties>
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(agentTaskTypesOptedOutOfAuto(xml), ["senior:special"]);
});

test("agentTaskTypesOptedOutOfAuto tolerates reversed attribute order (name/value swapped)", () => {
  const xml = `
    <bpmn:serviceTask id="agent">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:special" />
        <zeebe:property value="false" name="io.nanobpm.agentTask.autoSubscribe" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(agentTaskTypesOptedOutOfAuto(xml), ["senior:special"]);
});

test("agentTaskTypesOptedOutOfAuto ignores a task without the marker and one with a non-false value", () => {
  const xml = `
    <bpmn:serviceTask id="plain">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:feature" />
        <zeebe:agentDefinition agentType="external" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:serviceTask id="explicitTrue">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:retro" />
        <zeebe:property name="io.nanobpm.agentTask.autoSubscribe" value="true" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(agentTaskTypesOptedOutOfAuto(xml), []);
});

test("agentTaskTypesOptedOutOfAuto ignores an unrelated property named the same-ish", () => {
  const xml = `
    <bpmn:serviceTask id="agent">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:feature" />
        <zeebe:property name="io.nanobpm.agentTask.autoSubscribeMode" value="false" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(agentTaskTypesOptedOutOfAuto(xml), []);
});

test("GUARD: every deployed opted-out task is itself an externally-marked agent task", () => {
  for (const file of bpmnFiles()) {
    const xml = readFileSync(join(PROCESSES_DIR, file), "utf8");
    const optedOut = agentTaskTypesOptedOutOfAuto(xml);
    if (optedOut.length === 0) continue;
    // An opt-out only makes sense on a real agent task (one that WOULD otherwise be auto-discovered
    // via its external marker). If a type is opted out yet still appears as missing the external
    // marker, the opt-out has drifted onto a non-agent/incorrectly-authored element.
    const missing = agentTaskTypesMissingExternalMarker(xml);
    for (const type of optedOut) {
      assert(
        !missing.includes(type),
        `${file}: task "${type}" opts out of --auto but lacks <zeebe:agentDefinition agentType="external" /> — an opt-out belongs only on a real agent task`,
      );
    }
  }
});
