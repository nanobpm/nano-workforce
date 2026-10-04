// DEFECT-CLASS GUARD for the agent-task liveness SLA (issue #849): every deployed
// `<zeebe:agentDefinition agentType="external" />` service task must carry an interrupting
// TIMER boundary event, so a hung or looping agent escalates within its SLA instead of parking
// the process forever (the nanobpm/nano-bpm#1308 incident: `classify-scope` ran 7h27m unbounded
// while the worker kept renewing the job's deadline).
//
// The guard parses every `resources/processes/*.bpmn` and fails if any external agent task lacks
// an attached interrupting timer boundary — a newly-added agent task can't ship unbounded. It
// mirrors the sibling defect-class guard for the external AgentTask marker itself
// (`agent-marker.test.ts`, issue #745): the scan helper lives in `app/agentic/vocab/job-types.ts`
// and this test applies it to the whole deployed corpus.
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "#test-assert";
import { externalAgentTasksMissingSlaBoundary } from "./job-types.ts";

const PROCESSES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../resources/processes");

// urban deploys `resources/` recursively (every file at any depth), so a process model added
// under a subdirectory would still deploy — walk recursively here too, or the guard would miss
// it and let an unbounded agent task slip through.
function bpmnFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith(".bpmn") ? [relative(PROCESSES_DIR, full)] : [];
    });
  return walk(PROCESSES_DIR).sort();
}

test("externalAgentTasksMissingSlaBoundary flags an external agent task with no timer boundary", () => {
  const xml = `
    <bpmn:serviceTask id="agent">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:feature" />
        <zeebe:agentDefinition agentType="external" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>`;
  assertEquals(externalAgentTasksMissingSlaBoundary(xml), ["agent"]);
});

test("externalAgentTasksMissingSlaBoundary passes a bounded agent task and ignores a plain host task", () => {
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
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:boundaryEvent id="be_agent_sla" attachedToRef="agent">
      <bpmn:timerEventDefinition id="ted_agent_sla">
        <bpmn:timeDuration xsi:type="bpmn:tFormalExpression">=agentSlaTimeout</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>`;
  assertEquals(externalAgentTasksMissingSlaBoundary(xml), []);
});

test("externalAgentTasksMissingSlaBoundary rejects a non-timer boundary and a non-interrupting one", () => {
  const xml = `
    <bpmn:serviceTask id="msgBounded">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:a" />
        <zeebe:agentDefinition agentType="external" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:boundaryEvent id="be_msg" attachedToRef="msgBounded">
      <bpmn:messageEventDefinition id="med_msg" messageRef="Message_x" />
    </bpmn:boundaryEvent>
    <bpmn:serviceTask id="nonInterrupting">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:b" />
        <zeebe:agentDefinition agentType="external" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:boundaryEvent id="be_ni" attachedToRef="nonInterrupting" cancelActivity="false">
      <bpmn:timerEventDefinition id="ted_ni">
        <bpmn:timeDuration xsi:type="bpmn:tFormalExpression">=agentSlaTimeout</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>`;
  assertEquals(externalAgentTasksMissingSlaBoundary(xml), ["msgBounded", "nonInterrupting"]);
});

test("DEFECT-CLASS GUARD: every deployed external agent task carries an interrupting timer SLA boundary", () => {
  let anyAgentTasks = false;
  for (const file of bpmnFiles()) {
    const xml = readFileSync(join(PROCESSES_DIR, file), "utf8");
    if (/<(?:\w+:)?agentDefinition\b[^>]*\bagentType="external"/.test(xml)) anyAgentTasks = true;
    const missing = externalAgentTasksMissingSlaBoundary(xml);
    assert(
      missing.length === 0,
      `${file}: external agent task(s) with no interrupting timer SLA boundary — ${missing.join(", ")} ` +
        `(issue #849: an unbounded agent task parks the process forever; attach a timer boundary ` +
        `whose <bpmn:timeDuration>=agentSlaTimeout routes to the process's escalation path)`,
    );
  }
  // Sanity: the models really do declare external agent tasks (guard is not vacuously green).
  assert(anyAgentTasks, "the deployed models declare external agent tasks");
});
