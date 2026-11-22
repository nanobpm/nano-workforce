/**
 * The ONE canonical FEEL expression for an escalation user task's `zeebe:assignmentDefinition`
 * `assignee`. Every escalation task nwf deploys uses it — the hand-authored
 * `resources/processes/*.bpmn` (pinned equal by `escalationAssignee.test.ts`) and the delivery-graph
 * compiler's `human` node (which imports it) — so the two can never drift.
 *
 * It must end in `else ""`, never `else null`: the engine evaluates an assignee with Zeebe's
 * `evaluateStringExpression`, where `null` is an EXTRACT_VALUE_ERROR incident and an empty string
 * means unassigned (nano-bpm #1398).
 */
export const ESCALATION_ASSIGNEE_FEEL =
  '=if (is defined(escalationAssignee) and escalationAssignee != null and trim(string(escalationAssignee)) != "") then escalationAssignee else ""';
