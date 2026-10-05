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
// and this test applies it to the bounded subset of the deployed corpus (see BOUNDED_PROCESSES).
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "#test-assert";
import { externalAgentTasksMissingSlaBoundary } from "./job-types.ts";

const PROCESSES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../resources/processes");

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
      <bpmn:outgoing>f_agent_sla</bpmn:outgoing>
      <bpmn:timerEventDefinition id="ted_agent_sla">
        <bpmn:timeDuration xsi:type="bpmn:tFormalExpression">=agentSlaTimeout</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="f_agent_sla" sourceRef="be_agent_sla" targetRef="somewhere" />`;
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
    </bpmn:boundaryEvent>
    <bpmn:serviceTask id="nonInterruptingZero">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:c" />
        <zeebe:agentDefinition agentType="external" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:boundaryEvent id="be_ni0" attachedToRef="nonInterruptingZero" cancelActivity="0">
      <bpmn:outgoing>f_ni0</bpmn:outgoing>
      <bpmn:timerEventDefinition id="ted_ni0">
        <bpmn:timeDuration xsi:type="bpmn:tFormalExpression">=agentSlaTimeout</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="f_ni0" sourceRef="be_ni0" targetRef="esc" />`;
  // cancelActivity="0" is the OTHER XSD-boolean false form — it is just as non-interrupting as
  // "false", so the guard must reject it too (else a hung agent runs on past the boundary).
  assertEquals(externalAgentTasksMissingSlaBoundary(xml), ["msgBounded", "nonInterrupting", "nonInterruptingZero"]);
});

// The defect class a too-loose scanner would bless (review finding): an interrupting TIMER boundary
// is necessary but NOT sufficient — it must also arm the canonical `=agentSlaTimeout` duration AND
// route somewhere. Each case below is a boundary that LOOKS like an SLA bound but is not.
test("externalAgentTasksMissingSlaBoundary rejects a timer with no timeDuration, a wrong expression, or no outgoing flow", () => {
  const xml = `
    <bpmn:serviceTask id="noDuration">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:a" />
        <zeebe:agentDefinition agentType="external" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:boundaryEvent id="be_no_duration" attachedToRef="noDuration">
      <bpmn:outgoing>f_no_duration</bpmn:outgoing>
      <bpmn:timerEventDefinition id="ted_no_duration" />
    </bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="f_no_duration" sourceRef="be_no_duration" targetRef="esc" />
    <bpmn:serviceTask id="wrongExpr">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:b" />
        <zeebe:agentDefinition agentType="external" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:boundaryEvent id="be_wrong_expr" attachedToRef="wrongExpr">
      <bpmn:outgoing>f_wrong_expr</bpmn:outgoing>
      <bpmn:timerEventDefinition id="ted_wrong_expr">
        <bpmn:timeDuration xsi:type="bpmn:tFormalExpression">PT2H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="f_wrong_expr" sourceRef="be_wrong_expr" targetRef="esc" />
    <bpmn:serviceTask id="disconnected">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="senior:c" />
        <zeebe:agentDefinition agentType="external" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:boundaryEvent id="be_disconnected" attachedToRef="disconnected">
      <bpmn:timerEventDefinition id="ted_disconnected">
        <bpmn:timeDuration xsi:type="bpmn:tFormalExpression">=agentSlaTimeout</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>`;
  // noDuration: timer without a timeDuration never arms the SLA. wrongExpr: a hard-coded PT2H does
  // not track the seeded `agentSlaTimeout`. disconnected: a boundary with no outgoing flow cancels
  // the agent without escalating. All three must be flagged.
  assertEquals(externalAgentTasksMissingSlaBoundary(xml), ["noDuration", "wrongExpr", "disconnected"]);
});

// Processes whose external agent tasks are bounded by an SLA timer boundary (issue #849).
// convergence-loop.bpmn and plan-fanout.bpmn are INTENTIONALLY absent: their agent tasks
// (`review-round` / `adversarial-review` / `classify-scope`, and `plan`) sit on a back-edge-loop
// target, and bpmn-auto-layout cannot route a bottom-exit timer boundary there (ROUTING_FAILED —
// layouter bug #867; the bound-the-rest follow-up is #868). They are bounded once the layouter
// fix lands; until then this list is the landed scope, and the corpus assertion below covers
// exactly these processes so a regression on a *bounded* process is caught while the deferred
// two stay out. merge-loop.bpmn's agent tasks (`fix-ci` / `rebase`) were bounded in an earlier
// #849 commit, so it belongs here too — every already-bounded process stays regression-guarded.
const BOUNDED_PROCESSES = ["implement-cell.bpmn", "merge-cell.bpmn", "merge-loop.bpmn", "retro.bpmn"] as const;

test("DEFECT-CLASS GUARD: every external agent task in a bounded process carries an interrupting timer SLA boundary", () => {
  let anyAgentTasks = false;
  for (const file of BOUNDED_PROCESSES) {
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
  // Sanity: the bounded models really do declare external agent tasks (guard is not vacuously green).
  assert(anyAgentTasks, "the bounded models declare external agent tasks");
});
