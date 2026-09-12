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
import { assertEquals } from "#test-assert";
import {
  agentTaskTypesMissingExternalMarker,
  agentTaskTypesOptedOutMissingExternalMarker,
  agentTaskTypesOptedOutOfAuto,
  MALFORMED_OPTOUT_LABEL,
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
        <zeebe:properties>
          <zeebe:property value="false" name="io.nanobpm.agentTask.autoSubscribe" />
        </zeebe:properties>
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
        <zeebe:properties>
          <zeebe:property name="io.nanobpm.agentTask.autoSubscribe" value="true" />
        </zeebe:properties>
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(agentTaskTypesOptedOutOfAuto(xml), []);
});

test("agentTaskTypesOptedOutOfAuto ignores an unrelated property named the same-ish", () => {
  const xml = `
    <bpmn:serviceTask id="agent">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:feature" />
        <zeebe:properties>
          <zeebe:property name="io.nanobpm.agentTask.autoSubscribeMode" value="false" />
        </zeebe:properties>
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(agentTaskTypesOptedOutOfAuto(xml), []);
});

test("agentTaskTypesOptedOutMissingExternalMarker flags an opt-out on a block lacking the external marker", () => {
  // A host task (no external marker, no prompt link) that carries the opt-out is authoring drift:
  // the block-level check catches it even though `agentTaskTypesMissingExternalMarker` (prompt-only)
  // never reports it.
  const xml = `
    <bpmn:serviceTask id="host">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="pr.finalize" />
        <zeebe:properties>
          <zeebe:property name="io.nanobpm.agentTask.autoSubscribe" value="false" />
        </zeebe:properties>
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(agentTaskTypesMissingExternalMarker(xml), []);
  assertEquals(agentTaskTypesOptedOutMissingExternalMarker(xml), ["pr.finalize"]);
});

test("agentTaskTypesOptedOutMissingExternalMarker passes an opt-out on an externally-marked agent task", () => {
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
  assertEquals(agentTaskTypesOptedOutMissingExternalMarker(xml), []);
});

test("agentTaskTypesOptedOutMissingExternalMarker checks each block independently (a marked sibling does not cover a drifted opt-out)", () => {
  // Two tasks share the `senior:special` type: one is a proper externally-marked agent task, the
  // other opts out but lacks the marker. A deduplicated cross-task comparison would miss this; the
  // per-block check flags the unmarked one.
  const xml = `
    <bpmn:serviceTask id="marked">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:special" />
        <zeebe:agentDefinition agentType="external" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:serviceTask id="drifted">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:special" />
        <zeebe:properties>
          <zeebe:property name="io.nanobpm.agentTask.autoSubscribe" value="false" />
        </zeebe:properties>
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(agentTaskTypesOptedOutMissingExternalMarker(xml), ["senior:special"]);
});

test("agentTaskTypesOptedOutMissingExternalMarker flags an opt-out whose external marker sits OUTSIDE extensionElements (placement contract)", () => {
  // The opt-out is correctly placed inside extensionElements, but the external marker is out of place
  // (a sibling of <serviceTask>, not inside extensionElements) so the engine ignores it — the block
  // is therefore NOT a real marked agent task. A whole-block scan would see the marker "somewhere" and
  // wrongly pass; the placement-scoped scan flags the drift.
  const xml = `
    <bpmn:serviceTask id="misplaced">
      <zeebe:agentDefinition agentType="external" />
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:special" />
        <zeebe:properties>
          <zeebe:property name="io.nanobpm.agentTask.autoSubscribe" value="false" />
        </zeebe:properties>
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(agentTaskTypesOptedOutMissingExternalMarker(xml), ["senior:special"]);
});

test("agentTaskTypesOptedOutMissingExternalMarker surfaces an opt-out on a block with a missing/empty taskDefinition type", () => {
  // An opt-out on an unmarked block whose <zeebe:taskDefinition> type is empty cannot be a real agent
  // task, so it is still drift — surfaced under the sentinel rather than silently skipped.
  const xml = `
    <bpmn:serviceTask id="typeless">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="" />
        <zeebe:properties>
          <zeebe:property name="io.nanobpm.agentTask.autoSubscribe" value="false" />
        </zeebe:properties>
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(agentTaskTypesOptedOutMissingExternalMarker(xml), [MALFORMED_OPTOUT_LABEL]);
});

test("agentTaskTypesOptedOutMissingExternalMarker surfaces a MARKED opt-out block with a missing/empty taskDefinition type", () => {
  // The block carries BOTH the external marker AND the opt-out, but its <zeebe:taskDefinition> type
  // is empty — so it still cannot be a real agent task. The malformed check must run BEFORE the
  // external-marker short-circuit, or the marker would wrongly let this typeless opt-out pass.
  const xml = `
    <bpmn:serviceTask id="markedTypeless">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="" />
        <zeebe:agentDefinition agentType="external" />
        <zeebe:properties>
          <zeebe:property name="io.nanobpm.agentTask.autoSubscribe" value="false" />
        </zeebe:properties>
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(agentTaskTypesOptedOutMissingExternalMarker(xml), [MALFORMED_OPTOUT_LABEL]);
});

test("GUARD: every deployed opted-out task is itself an externally-marked agent task", () => {
  for (const file of bpmnFiles()) {
    const xml = readFileSync(join(PROCESSES_DIR, file), "utf8");
    // Drive the guard DIRECTLY from the block-level, placement-scoped helper rather than gating on
    // `agentTaskTypesOptedOutOfAuto` (which skips missing/empty task-definition types, so a typeless
    // opt-out would never reach the check). The helper scans every service task itself, surfaces a
    // malformed typeless opt-out under the sentinel, and checks the external marker on the SAME
    // block's extensionElements — so a typeless opt-out, an out-of-place property, or a marker that
    // drifted onto a non-agent element all fail CI here.
    const drifted = agentTaskTypesOptedOutMissingExternalMarker(xml);
    assertEquals(
      drifted,
      [],
      `${file}: task(s) ${JSON.stringify(drifted)} opt out of --auto but lack <zeebe:agentDefinition agentType="external" /> on the same block — an opt-out belongs only on a real agent task`,
    );
  }
});
